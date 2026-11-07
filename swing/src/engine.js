// Portfolio engine — pure functions shared by the live bot and the backtest.
// One trading day t (UTC 00:00) is processed in three steps, always in this order:
//   openDay(t)   : exits decided at the previous close, then entries (ranked), at the day's open
//   intraday(t)  : breakout SL/TP on intraday bars (SL first when both are inside one bar)
//   closeDay(t)  : breakout time stop, R3 exit signals, equity mark, circuit breaker, new signals
// Real positions share one cash balance; each trade uses equity/slotsTotal (≈ 50/50 between the two
// strategies with 6 slots each). Every raw signal also opens a "shadow" trade with no capital limits,
// so the signal ledger can tell whether the indicator was right even when the trade was skipped.
// Every signal is also scored on pure forward returns (1/3/5/10 days) against an equal-weight basket
// of all coins, i.e. "did this coin beat the market after the signal?" independent of exit rules.
import { DAY, floorStep } from './util.js';
import { r3Entry, r3Exit, breakoutEntry, breakoutLevel, trendUp } from './strategy.js';

export const STRATEGIES = ['R3', 'BREAKOUT'];
const params = (cfg, strat) => (strat === 'R3' ? cfg.r3 : cfg.breakout);
export const slipOf = (cfg, sym) => cfg.slippage[sym] ?? cfg.slippage.default;

export function newState(cfg, firstDay) {
  return {
    version: 1,
    capital: cfg.capital,
    cash: cfg.capital,
    equity: cfg.capital,
    peak: cfg.capital,
    maxDrawdown: 0,
    breaker: null,
    lastOpenedDay: firstDay - DAY,
    lastClosedDay: firstDay - DAY,
    nextId: 1,
    positions: [],
    pending: { exits: [], entries: [] },
    shadows: [],
    forward: [],
    basket: { level: 1, day: null },
  };
}

const holdDays = (from, to) => Math.max(1, Math.round((to - from) / DAY));

function closeReal(state, p, px, feeOut, time, reason, ev, late = false) {
  const proceeds = p.qty * px * (1 - feeOut);
  state.cash += proceeds;
  state.positions.splice(state.positions.indexOf(p), 1);
  state.pending.exits = state.pending.exits.filter((x) => x.positionId !== p.id);
  const ret = proceeds / p.cost - 1;
  ev.push({
    type: 'trade_close',
    trade: {
      id: p.id, signalId: p.signalId, strategy: p.strategy, symbol: p.symbol,
      entryTime: p.entryTime, entryPx: p.entryPx, qty: p.qty, cost: p.cost, sl: p.sl, tp: p.tp,
      exitTime: time, exitPx: px, proceeds, pnl: proceeds - p.cost, ret,
      R: p.risk ? (ret * p.entryPx) / p.risk : null,
      days: holdDays(p.entryTime, time), reason, mfe: p.mfe, mae: p.mae, lateEntry: !!p.late, lateExit: !!late,
    },
  });
}

function closeShadow(state, s, px, feeOut, time, reason, ev, cfg) {
  const ret = (px * (1 - feeOut)) / (s.entryPx * (1 + cfg.fees.taker)) - 1;
  state.shadows.splice(state.shadows.indexOf(s), 1);
  ev.push({ type: 'signal_result', id: s.id, symbol: s.symbol, strategy: s.strategy, entryPx: s.entryPx, exitTime: time, exitPx: px, ret, R: s.risk ? (ret * s.entryPx) / s.risk : null, days: holdDays(s.entryTime, time), reason, mfe: s.mfe, mae: s.mae });
}

function close(kind, state, h, px, feeOut, time, reason, ev, cfg, late) {
  if (kind === 'real') closeReal(state, h, px, feeOut, time, reason, ev, late);
  else closeShadow(state, h, px, feeOut, time, reason, ev, cfg);
}

function holdersOf(state, symbol, strategy) {
  const match = (h) => (strategy == null || h.strategy === strategy) && (symbol == null || h.symbol === symbol);
  return [...state.positions.filter(match).map((h) => ['real', h]), ...state.shadows.filter(match).map((h) => ['shadow', h])];
}
const breakoutHolders = (state, symbol) => holdersOf(state, symbol, 'BREAKOUT');

export const hasBreakoutHolder = (state, symbol) => breakoutHolders(state, symbol).length > 0;
export const hasHolder = (state, symbol) => holdersOf(state, symbol).length > 0;
// First intraday time still unprocessed for a symbol (null = nothing to track).
export function intradayNeed(state, symbol) {
  const hs = holdersOf(state, symbol);
  return hs.length ? Math.min(...hs.map(([, h]) => (h.lastBarEnd != null ? h.lastBarEnd + 1 : h.entryTime))) : null;
}

function excursion(h, high, low) {
  h.mfe = Math.max(h.mfe, high / h.entryPx - 1);
  h.mae = Math.min(h.mae, low / h.entryPx - 1);
}

// ---------------------------------------------------------------- open
// ctx.price(sym, t, side) -> { px, time, late } | null   (execution price incl. timing rules)
// ctx.openPrice(sym, t)   -> historical open of day t | null (shadows always use the day open)
// ctx.filters(sym)        -> { status, step, minNotional } | null
export function openDay(state, t, ctx) {
  const { cfg } = ctx;
  const ev = [];
  if (t <= state.lastOpenedDay) return ev;
  const fee = cfg.fees.taker;

  for (const ex of [...state.pending.exits]) {
    const p = state.positions.find((x) => x.id === ex.positionId);
    if (!p) {
      state.pending.exits = state.pending.exits.filter((x) => x !== ex);
      continue;
    }
    const q = ctx.price(p.symbol, t, 'sell');
    if (q) closeReal(state, p, q.px * (1 - slipOf(cfg, p.symbol)), fee, q.time, ex.reason, ev, q.late);
  }
  for (const s of state.shadows.filter((x) => x.pendingExit)) {
    const o = ctx.openPrice(s.symbol, t);
    if (o != null) closeShadow(state, s, o * (1 - slipOf(cfg, s.symbol)), fee, t, s.pendingExit, ev, cfg);
  }

  const entries = state.pending.entries;
  state.pending.entries = [];
  const equityRef = state.equity; // marked at the previous close
  for (const strat of STRATEGIES) {
    const P = params(cfg, strat);
    let opened = 0;
    for (const e of entries.filter((x) => x.strategy === strat).sort((a, b) => a.rank - b.rank)) {
      const o = ctx.openPrice(e.symbol, t);
      if (o != null) openShadow(state, e, o * (1 + slipOf(cfg, e.symbol)), t, cfg);
      const r = tryEnter(state, e, t, ctx, P, opened, equityRef);
      if (r.position) {
        opened++;
        ev.push({ type: 'trade_open', position: { ...r.position } });
      }
      ev.push({ type: 'signal_update', id: e.signalId, symbol: e.symbol, strategy: e.strategy, status: r.position ? 'taken' : 'skipped', reason: r.reason ?? null, positionId: r.position?.id ?? null, entryPx: r.position?.entryPx ?? null });
    }
  }
  state.lastOpenedDay = t;
  return ev;
}

function openShadow(state, e, entryPx, t, cfg) {
  const s = { id: e.signalId, strategy: e.strategy, symbol: e.symbol, entryDay: t, entryTime: t, entryPx, days: 0, mfe: 0, mae: 0, lastBarEnd: null, pendingExit: null, risk: null, sl: null, tp: null };
  if (e.strategy === 'BREAKOUT') {
    s.risk = cfg.breakout.slAtr * e.atr;
    s.sl = entryPx - s.risk;
    s.tp = entryPx + cfg.breakout.rr * s.risk;
    if (!(s.sl > 0)) return;
  }
  state.shadows.push(s);
}

function tryEnter(state, e, t, ctx, P, opened, equityRef) {
  const { cfg } = ctx;
  const fee = cfg.fees.taker;
  if (!P.enabled) return { reason: 'disabled' };
  if (!e.btcOk) return { reason: 'btc_filter' };
  if (state.breaker) return { reason: 'breaker' };
  if (state.positions.some((p) => p.strategy === e.strategy && p.symbol === e.symbol)) return { reason: 'already_holding' };
  if (state.positions.filter((p) => p.strategy === e.strategy).length >= P.maxPositions) return { reason: 'slots_full' };
  if (opened >= P.maxNewPerDay) return { reason: 'max_new_per_day' };
  const f = ctx.filters(e.symbol);
  if (f && f.status && f.status !== 'TRADING') return { reason: 'not_trading' };
  const q = ctx.price(e.symbol, t, 'buy');
  if (!q) return { reason: ctx.isLate(t) ? 'late' : 'no_price' };
  const entryPx = q.px * (1 + slipOf(cfg, e.symbol));
  let sl = null, tp = null, risk = null;
  if (e.strategy === 'BREAKOUT') {
    risk = P.slAtr * e.atr;
    sl = entryPx - risk;
    tp = entryPx + P.rr * risk;
    if (!(sl > 0)) return { reason: 'invalid_sl' };
  }
  const alloc = Math.min(equityRef / cfg.slotsTotal, state.cash / (1 + fee));
  const qty = floorStep(alloc / entryPx, f?.step);
  const notional = qty * entryPx;
  if (!(qty > 0) || notional < Math.max(cfg.minOrderUsd, f?.minNotional ?? 0)) return { reason: 'below_min_order' };
  const cost = notional * (1 + fee);
  state.cash -= cost;
  const position = { id: `P${state.nextId++}`, signalId: e.signalId, strategy: e.strategy, symbol: e.symbol, entryDay: t, entryTime: q.time, entryPx, qty, cost, sl, tp, risk, days: 0, mfe: 0, mae: 0, lastBarEnd: null, lastPx: entryPx, late: !!q.late };
  state.positions.push(position);
  return { position };
}

// ---------------------------------------------------------------- intraday
// bars: ascending { t, o, h, l, c, ct } for one symbol (1m live bars, 1m/1h REST, 4h in backtest).
// Idempotent on the bar END time, so bars of different sizes can be mixed without double counting.
// R3 holders only get MFE/MAE; breakout holders also get SL/TP.
export function intraday(state, symbol, bars, ctx, { realOnly = false } = {}) {
  const { cfg } = ctx;
  const ev = [];
  const slip = slipOf(cfg, symbol);
  for (const [kind, h] of holdersOf(state, symbol)) {
    if (realOnly && kind !== 'real') continue;
    for (const b of bars) {
      if (b.ct < h.entryTime || (h.lastBarEnd != null && b.ct <= h.lastBarEnd)) continue;
      h.lastBarEnd = b.ct;
      excursion(h, b.h, b.l);
      if (h.strategy !== 'BREAKOUT') continue;
      const first = b.t <= h.entryTime; // bar containing the entry: no gap logic
      if (b.l <= h.sl) {
        close(kind, state, h, (first ? h.sl : Math.min(h.sl, b.o)) * (1 - slip), cfg.fees.taker, b.ct + 1, 'SL', ev, cfg);
        break;
      }
      if (b.h >= h.tp) {
        close(kind, state, h, h.tp, cfg.fees.maker, b.ct + 1, 'TP', ev, cfg);
        break;
      }
    }
  }
  return ev;
}

// ---------------------------------------------------------------- close
// ctx.series(sym) -> buildSeries() result (closed candles up to at least t); ctx.symbols -> list
export function closeDay(state, t, ctx) {
  const { cfg } = ctx;
  const ev = [];
  if (t <= state.lastClosedDay) return ev;
  const at = (sym) => {
    const S = ctx.series(sym);
    const i = S?.idx.get(t);
    return i == null ? null : { S, i };
  };

  for (const [kind, h] of breakoutHolders(state)) {
    if (h.entryDay > t) continue;
    h.days++;
    const b = at(h.symbol);
    if (b && h.days >= cfg.breakout.maxHoldDays) close(kind, state, h, b.S.c[b.i] * (1 - slipOf(cfg, h.symbol)), cfg.fees.taker, t + DAY, 'TIME', ev, cfg);
  }

  for (const p of state.positions.filter((x) => x.strategy === 'R3')) {
    const b = at(p.symbol);
    if (!b) continue;
    excursion(p, b.S.h[b.i], b.S.l[b.i]);
    if (r3Exit(b.S, b.i, cfg.r3) && !state.pending.exits.some((x) => x.positionId === p.id)) state.pending.exits.push({ positionId: p.id, reason: 'RSI2>70' });
  }
  for (const s of state.shadows.filter((x) => x.strategy === 'R3' && !x.pendingExit)) {
    const b = at(s.symbol);
    if (!b) continue;
    excursion(s, b.S.h[b.i], b.S.l[b.i]);
    if (r3Exit(b.S, b.i, cfg.r3)) s.pendingExit = 'RSI2>70';
  }

  let equity = state.cash;
  for (const p of state.positions) {
    const b = at(p.symbol);
    if (b) p.lastPx = b.S.c[b.i];
    equity += p.qty * p.lastPx;
  }
  state.equity = equity;
  state.peak = Math.max(state.peak, equity);
  const dd = 1 - equity / state.peak;
  state.maxDrawdown = Math.max(state.maxDrawdown, dd);
  ev.push({ type: 'equity', t, equity, cash: state.cash, dd, open: state.positions.length });
  if (!state.breaker && dd >= cfg.circuitBreakerDrawdown) {
    state.breaker = { at: t, dd };
    ev.push({ type: 'breaker', at: t, dd });
  }

  // Equal-weight basket of all coins (daily close-to-close) and forward scoring of past signals.
  const rets = [];
  for (const sym of ctx.symbols) {
    const b = at(sym);
    if (b && b.i > 0) rets.push(b.S.c[b.i] / b.S.c[b.i - 1] - 1);
  }
  if (!state.basket) state.basket = { level: 1, day: null };
  if (!state.forward) state.forward = [];
  if (rets.length) state.basket.level *= 1 + rets.reduce((a, x) => a + x, 0) / rets.length;
  state.basket.day = t;
  const horizons = cfg.forwardHorizons ?? [1, 3, 5, 10];
  for (const f of [...state.forward]) {
    const b = at(f.symbol);
    if (!b) continue;
    f.age++;
    if (horizons.includes(f.age)) ev.push({ type: 'signal_forward', id: f.id, h: f.age, ret: b.S.c[b.i] / f.c0 - 1, basket: state.basket.level / f.b0 - 1 });
    if (f.age >= Math.max(...horizons)) state.forward.splice(state.forward.indexOf(f), 1);
  }

  const btc = at('BTCUSDT');
  const btcOk = !cfg.btcFilter || (btc != null && trendUp(btc.S, btc.i));
  for (const sym of ctx.symbols) {
    const b = at(sym);
    if (!b) continue;
    const { S, i } = b;
    if (cfg.r3.enabled && r3Entry(S, i, cfg.r3)) {
      addSignal(state, ev, t, 'R3', sym, S.r2[i], btcOk, null, { close: S.c[i], sma200: S.s200[i], rsi2: S.r2[i], rsi2Start: S.r2[i - 3] }, S.c[i]);
    }
    if (cfg.breakout.enabled && breakoutEntry(S, i, cfg.breakout)) {
      addSignal(state, ev, t, 'BREAKOUT', sym, S.atr[i] / S.c[i], btcOk, S.atr[i], { close: S.c[i], level: breakoutLevel(S, i, cfg.breakout.lookback), atr: S.atr[i], atrPct: S.atr[i] / S.c[i] }, S.c[i]);
    }
  }
  state.lastClosedDay = t;
  return ev;
}

function addSignal(state, ev, t, strategy, symbol, rank, btcOk, atr, values, close) {
  const id = `S${state.nextId++}`;
  state.pending.entries.push({ signalId: id, strategy, symbol, rank, btcOk, atr });
  state.forward.push({ id, symbol, c0: close, b0: state.basket.level, age: 0 });
  ev.push({ type: 'signal', id, day: t, strategy, symbol, btcOk, rank, values });
}
