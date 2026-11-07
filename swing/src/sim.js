// Historical replay with the exact same engine as the live bot.
import { DAY, dayStart } from './util.js';
import { buildSeries } from './strategy.js';
import { newState, openDay, intraday, closeDay, hasBreakoutHolder } from './engine.js';

// Collects engine events into tables (shared by backtest and the live store).
export function createLedger() {
  const L = { trades: [], opens: [], signals: new Map(), equity: [], breakers: [] };
  L.apply = (events) => {
    for (const e of events) {
      if (e.type === 'trade_close') L.trades.push(e.trade);
      else if (e.type === 'trade_open') L.opens.push(e.position);
      else if (e.type === 'signal') L.signals.set(e.id, { ...e });
      else if (e.type === 'signal_forward') {
        const s = L.signals.get(e.id);
        if (s) s.forward = { ...(s.forward || {}), [e.h]: { ret: e.ret, basket: e.basket } };
      } else if (e.type === 'signal_update' || e.type === 'signal_result') {
        const s = L.signals.get(e.id);
        if (s) Object.assign(s, e.type === 'signal_result' ? { result: e } : { status: e.status, reason: e.reason, positionId: e.positionId, entryPx: e.entryPx });
      } else if (e.type === 'equity') L.equity.push(e);
      else if (e.type === 'breaker') L.breakers.push(e);
    }
  };
  return L;
}

// daily: { SYM: [{t,o,h,l,c,v}] closed daily candles } ; intraday: { SYM: [{t,o,h,l,c,ct}] }
export function simulate({ cfg, daily, intraday: intra = {}, from, to = Infinity }) {
  const symbols = cfg.coins.filter((s) => daily[s]?.length);
  const series = new Map(symbols.map((s) => [s, buildSeries(daily[s])]));
  const days = [...new Set(symbols.flatMap((s) => daily[s].map((k) => k.t)))].filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const barsByDay = new Map(
    symbols.map((s) => {
      const m = new Map();
      for (const b of intra[s] || []) {
        const d = dayStart(b.t);
        if (!m.has(d)) m.set(d, []);
        m.get(d).push(b);
      }
      return [s, m];
    })
  );
  const openPrice = (s, t) => {
    const S = series.get(s);
    const i = S?.idx.get(t);
    return i == null ? null : S.o[i];
  };
  const ctx = {
    cfg,
    symbols,
    series: (s) => series.get(s),
    filters: () => null,
    openPrice,
    price: (s, t) => {
      const o = openPrice(s, t);
      return o == null ? null : { px: o, time: t, late: false };
    },
    isLate: () => false,
  };
  const state = newState(cfg, days[0]);
  const L = createLedger();
  for (const t of days) {
    L.apply(openDay(state, t, ctx));
    for (const s of symbols) if (hasBreakoutHolder(state, s)) L.apply(intraday(state, s, barsByDay.get(s).get(t) || [], ctx));
    L.apply(closeDay(state, t, ctx));
  }
  return { state, ...L, days };
}

export function summarize({ trades, equity, days, state }) {
  const capital = state.capital;
  const years = (days.at(-1) - days[0] + DAY) / (365.25 * DAY);
  const last = equity.at(-1)?.equity ?? capital;
  let peak = capital, dd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.equity);
    dd = Math.max(dd, 1 - e.equity / peak);
  }
  const yearEnd = new Map();
  for (const e of equity) yearEnd.set(new Date(e.t).getUTCFullYear(), e.equity);
  let prev = capital;
  const byYear = [...yearEnd].map(([y, v]) => {
    const r = (v / prev - 1) * 100;
    prev = v;
    return [y, r];
  });
  const by = (s) => {
    const T = trades.filter((x) => x.strategy === s);
    const n = T.length;
    const avg = (f) => (n ? T.reduce((a, x) => a + f(x), 0) / n : null);
    return {
      n,
      win: n ? (T.filter((x) => x.ret > 0).length / n) * 100 : null,
      avgRet: n ? avg((x) => x.ret) * 100 : null,
      avgR: s === 'BREAKOUT' ? avg((x) => x.R) : null,
      tp: s === 'BREAKOUT' && n ? (T.filter((x) => x.reason === 'TP').length / n) * 100 : null,
    };
  };
  return { cagr: ((last / capital) ** (1 / years) - 1) * 100, maxDD: dd * 100, final: last, years, byYear, R3: by('R3'), BREAKOUT: by('BREAKOUT') };
}
