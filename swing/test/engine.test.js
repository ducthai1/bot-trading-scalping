import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newState, openDay, intraday, closeDay } from '../src/engine.js';
import { DAY, HOUR } from '../src/util.js';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const T0 = Date.UTC(2025, 0, 10);
const day = (k) => T0 + k * DAY;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Hand-made indicator series: rows[k] = { o, h, l, c, r2, s200, atr } for day(k).
function fakeSeries(rows) {
  const S = { t: [], o: [], h: [], l: [], c: [], r2: [], s200: [], atr: [], idx: new Map() };
  rows.forEach((r, k) => {
    S.t.push(day(k)); S.o.push(r.o ?? r.c); S.h.push(r.h ?? r.c); S.l.push(r.l ?? r.c); S.c.push(r.c);
    S.r2.push(r.r2 ?? 50); S.s200.push(r.s200 ?? 1); S.atr.push(r.atr ?? 1);
    S.idx.set(day(k), k);
  });
  return S;
}
// Four days whose last close is an R3 entry (RSI2 55 -> 40 -> 20 -> 5, close above SMA200).
const r3Days = (c = 100) => [{ c, r2: 55 }, { c, r2: 40 }, { c, r2: 20 }, { c, r2: 5 }];
const btcUp = () => fakeSeries(Array.from({ length: 12 }, () => ({ c: 100, s200: 50 })));

function makeCtx(cfg, map, { late = false } = {}) {
  return {
    cfg,
    symbols: Object.keys(map),
    series: (s) => map[s],
    filters: () => null,
    openPrice: (s, t) => { const S = map[s]; const i = S?.idx.get(t); return i == null ? null : S.o[i]; },
    price: (s, t, side) => {
      if (late && side === 'buy') return null;
      const S = map[s]; const i = S?.idx.get(t);
      return i == null ? null : { px: S.o[i], time: t, late };
    },
    isLate: () => late,
  };
}
const cfgWith = (o = {}) => ({ ...base, capital: 1200, minBars: undefined, r3: { ...base.r3, minBars: 0 }, breakout: { ...base.breakout, minBars: 0, lookback: 3 }, ...o });
const run = (state, ctx, k) => [...openDay(state, day(k), ctx), ...closeDay(state, day(k), ctx)];

test('R3: tín hiệu → mua lúc mở cửa → RSI2>70 → bán lúc mở cửa hôm sau; tiền khớp công thức phí + trượt giá', () => {
  const cfg = cfgWith({ breakout: { ...base.breakout, enabled: false } }); // ngày 4 cũng là breakout, tắt để chỉ thử R3
  const X = fakeSeries([...r3Days(), { o: 100, c: 104, r2: 80 }, { o: 106, c: 106 }]);
  const ctx = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: X });
  const st = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) run(st, ctx, k);
  assert.equal(st.pending.entries.length, 1);
  const ev4 = run(st, ctx, 4);
  const pos = ev4.find((e) => e.type === 'trade_open').position;
  const slip = cfg.slippage.default, fee = cfg.fees.taker;
  near(pos.entryPx, 100 * (1 + slip));
  near(pos.cost, pos.qty * pos.entryPx * (1 + fee));
  assert.equal(st.pending.exits.length, 1, 'RSI2 80 > 70 → chờ bán');
  const ev5 = run(st, ctx, 5);
  const tr = ev5.find((e) => e.type === 'trade_close').trade;
  near(tr.exitPx, 106 * (1 - slip));
  near(tr.ret, (106 * (1 - slip) * (1 - fee)) / (100 * (1 + slip) * (1 + fee)) - 1, 1e-12);
  assert.equal(tr.reason, 'RSI2>70');
  assert.equal(st.positions.length, 0);
  near(st.cash, 1200 - pos.cost + tr.proceeds, 1e-9);
});

test('Giới hạn mỗi ngày: 3 tín hiệu R3 cùng ngày → mở 2 lệnh RSI thấp nhất, lệnh thứ 3 bị bỏ (max_new_per_day); cả 3 đều có lệnh giả định', () => {
  const cfg = cfgWith();
  const mk = (last) => fakeSeries([{ c: 100, r2: 55 }, { c: 100, r2: 40 }, { c: 100, r2: 20 }, { c: 100, r2: last }, { c: 100 }]);
  const ctx = makeCtx(cfg, { BTCUSDT: btcUp(), AUSDT: mk(8), BUSDT: mk(3), CUSDT: mk(6) });
  const st = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) run(st, ctx, k);
  const ev = openDay(st, day(4), ctx);
  const opened = ev.filter((e) => e.type === 'trade_open').map((e) => e.position.symbol);
  assert.deepEqual(opened, ['BUSDT', 'CUSDT']);
  const skipped = ev.filter((e) => e.type === 'signal_update' && e.status === 'skipped');
  assert.deepEqual(skipped.map((e) => e.reason), ['max_new_per_day']);
  assert.equal(st.shadows.length, 3);
});

test('Lọc BTC và cầu dao chặn lệnh mới (vẫn ghi lệnh giả định)', () => {
  const cfg = cfgWith();
  const btcDown = fakeSeries(Array.from({ length: 6 }, () => ({ c: 40, s200: 50 })));
  const st = newState(cfg, day(0));
  const ctx = makeCtx(cfg, { BTCUSDT: btcDown, XUSDT: fakeSeries([...r3Days(), { c: 100 }]) });
  for (let k = 0; k <= 3; k++) run(st, ctx, k);
  const ev = openDay(st, day(4), ctx);
  assert.equal(ev.find((e) => e.type === 'signal_update').reason, 'btc_filter');
  assert.equal(st.shadows.length, 1);

  const st2 = newState(cfg, day(0));
  st2.breaker = { at: day(0), dd: 0.6 };
  const ctx2 = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: fakeSeries([...r3Days(), { c: 100 }]) });
  for (let k = 0; k <= 3; k++) run(st2, ctx2, k);
  assert.equal(openDay(st2, day(4), ctx2).find((e) => e.type === 'signal_update').reason, 'breaker');
});

test('Vốn quá nhỏ → below_min_order; quá trễ → late (bot không mua đuổi)', () => {
  const small = cfgWith({ capital: 20 });
  const ctxS = makeCtx(small, { BTCUSDT: btcUp(), XUSDT: fakeSeries([...r3Days(), { c: 100 }]) });
  const st = newState(small, day(0));
  for (let k = 0; k <= 3; k++) run(st, ctxS, k);
  assert.equal(openDay(st, day(4), ctxS).find((e) => e.type === 'signal_update').reason, 'below_min_order');

  const cfg = cfgWith();
  const ctxL = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: fakeSeries([...r3Days(), { c: 100 }]) }, { late: true });
  const st2 = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) run(st2, ctxL, k);
  assert.equal(openDay(st2, day(4), ctxL).find((e) => e.type === 'signal_update').reason, 'late');
});

// Breakout: lookback 3 → day 3 closes above the highs of days 0-2. ATR 1 → SL = entry - 2, TP = entry + 6.
const boDays = () => [{ c: 10, h: 10 }, { c: 10, h: 10 }, { c: 10, h: 10 }, { c: 12, h: 12, atr: 1 }, { o: 12, c: 12 }];
const bar = (t, o, h, l, c) => ({ t, o, h, l, c, ct: t + HOUR - 1 });

function boSetup() {
  const cfg = cfgWith({ r3: { ...base.r3, enabled: false } });
  const ctx = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: fakeSeries(boDays()) });
  const st = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) run(st, ctx, k);
  openDay(st, day(4), ctx);
  const p = st.positions[0];
  return { cfg, ctx, st, p };
}

test('Breakout: SL = giá vào − 2 ATR, TP = giá vào + 3 × SL; SL và TP cùng 1 nến → tính SL trước', () => {
  const { cfg, ctx, st, p } = boSetup();
  near(p.sl, p.entryPx - 2);
  near(p.tp, p.entryPx + 6);
  const ev = intraday(st, 'XUSDT', [bar(day(4), 12, 20, 9, 15)], ctx);
  const tr = ev.find((e) => e.type === 'trade_close').trade;
  assert.equal(tr.reason, 'SL');
  near(tr.exitPx, p.sl * (1 - cfg.slippage.default));
});

test('Breakout: nến sau mở cửa gap dưới SL → khớp ở giá mở cửa; chạm TP → khớp đúng giá TP (phí maker)', () => {
  const a = boSetup();
  const evA = intraday(a.st, 'XUSDT', [bar(day(4), 12, 12.5, 11.5, 12), bar(day(4) + HOUR, 9, 9.5, 8, 9)], a.ctx);
  near(evA.find((e) => e.type === 'trade_close').trade.exitPx, 9 * (1 - a.cfg.slippage.default));
  const b = boSetup();
  const evB = intraday(b.st, 'XUSDT', [bar(day(4), 12, 19, 11, 18)], b.ctx);
  const tr = evB.find((e) => e.type === 'trade_close').trade;
  assert.equal(tr.reason, 'TP');
  near(tr.exitPx, b.p.tp);
  near(tr.ret, (b.p.tp * (1 - b.cfg.fees.maker) * b.p.qty) / b.p.cost - 1, 1e-12);
});

test('Breakout: quá maxHoldDays thì thoát ở giá đóng cửa', () => {
  const cfg = cfgWith({ r3: { ...base.r3, enabled: false }, breakout: { ...base.breakout, minBars: 0, lookback: 3, maxHoldDays: 2 } });
  const ctx = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: fakeSeries([...boDays(), { c: 12.5 }]) });
  const st = newState(cfg, day(0));
  const evs = [];
  for (let k = 0; k <= 5; k++) evs.push(...run(st, ctx, k));
  const tr = evs.find((e) => e.type === 'trade_close').trade;
  assert.equal(tr.reason, 'TIME');
  near(tr.exitPx, 12.5 * (1 - cfg.slippage.default));
});

test('Idempotent: chạy lại cùng ngày / cùng nến không tạo lệnh trùng', () => {
  const { st, ctx } = boSetup();
  assert.deepEqual(openDay(st, day(4), ctx), []);
  const bars = [bar(day(4), 12, 12.5, 11.5, 12)];
  intraday(st, 'XUSDT', bars, ctx);
  const again = intraday(st, 'XUSDT', bars, ctx);
  assert.deepEqual(again, []);
  const c1 = closeDay(st, day(4), ctx);
  assert.ok(c1.length > 0);
  assert.deepEqual(closeDay(st, day(4), ctx), []);
});

test('Đánh giá vốn cuối ngày + cầu dao ngắt khi sụt quá ngưỡng', () => {
  const cfg = cfgWith({ circuitBreakerDrawdown: 0.05, slotsTotal: 1, r3: { ...base.r3, minBars: 0, maxPositions: 1 }, breakout: { ...base.breakout, enabled: false, maxPositions: 0 } });
  const X = fakeSeries([...r3Days(), { o: 100, c: 50, r2: 30 }]);
  const ctx = makeCtx(cfg, { BTCUSDT: btcUp(), XUSDT: X });
  const st = newState(cfg, day(0));
  const evs = [];
  for (let k = 0; k <= 4; k++) evs.push(...run(st, ctx, k));
  const p = st.positions[0];
  near(st.equity, st.cash + p.qty * 50);
  assert.ok(evs.some((e) => e.type === 'breaker'));
  assert.ok(st.breaker.dd > 0.4);
});
