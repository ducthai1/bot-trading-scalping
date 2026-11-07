import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { LiveFeed } from '../src/live.js';
import { newState, openDay, intraday, closeDay, intradayNeed } from '../src/engine.js';
import { watchlist } from '../src/watch.js';
import { forwardStats, evaluation } from '../src/report.js';
import { DAY, HOUR, MIN } from '../src/util.js';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const quiet = { log() {}, warn() {} };

class FakeWS extends EventEmitter {
  static all = [];
  constructor(url) {
    super();
    this.url = url;
    this.terminated = false;
    FakeWS.all.push(this);
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('close');
  }
}
const kmsg = (s, i, x, t, c) => Buffer.from(JSON.stringify({ stream: `${s.toLowerCase()}@kline_${i}`, data: { e: 'kline', s, k: { i, x, t, T: t + (i === '1m' ? MIN : DAY) - 1, o: String(c), h: String(c + 1), l: String(c - 1), c: String(c), v: '1' } } }));

test('Realtime: 1 kết nối cho mọi coin (kline 1m + 1d), chỉ nến 1m ĐÃ ĐÓNG mới được xử lý, giá cập nhật liên tục', () => {
  FakeWS.all = [];
  const bars = [];
  const f = new LiveFeed({ symbols: ['BTCUSDT', 'ETHUSDT'], onBar: (s, b) => bars.push([s, b]), log: quiet, WS: FakeWS });
  f.start();
  const ws = FakeWS.all[0];
  assert.match(ws.url, /btcusdt@kline_1m\/btcusdt@kline_1d\/ethusdt@kline_1m\/ethusdt@kline_1d$/);
  ws.emit('open');
  ws.emit('message', kmsg('BTCUSDT', '1m', false, 0, 100));
  ws.emit('message', kmsg('BTCUSDT', '1m', true, 0, 101));
  ws.emit('message', kmsg('ETHUSDT', '1d', false, 0, 2000));
  assert.equal(bars.length, 1);
  assert.equal(bars[0][1].c, 101);
  assert.equal(f.prices.BTCUSDT, 101);
  assert.equal(f.daily.ETHUSDT.c, 2000);
  assert.equal(f.healthy(), true);
  f.stop();
});

test('Realtime: socket im lặng → watchdog ngắt và kết nối lại có giãn cách (không spam kết nối)', () => {
  FakeWS.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = new LiveFeed({ symbols: ['BTCUSDT'], onBar: () => {}, log: quiet, WS: FakeWS, staleMs: 60e3 });
  f.start();
  FakeWS.all[0].emit('open');
  mock.timers.tick(70e3);
  assert.equal(FakeWS.all[0].terminated, true);
  for (let i = 0; i < 300; i++) {
    mock.timers.tick(1000);
    const last = FakeWS.all.at(-1);
    if (!last.terminated) last.terminate(); // every new connection fails immediately
  }
  const n = FakeWS.all.length;
  f.stop();
  mock.timers.reset();
  assert.ok(n <= 20, `${n} lần kết nối trong 5 phút`);
});

// ----- engine: mixed bar sizes, R3 MFE/MAE intraday, forward returns vs basket
const T0 = Date.UTC(2025, 0, 10);
const day = (k) => T0 + k * DAY;
function fakeSeries(rows) {
  const S = { t: [], o: [], h: [], l: [], c: [], r2: [], s200: [], atr: [], idx: new Map() };
  rows.forEach((r, k) => {
    S.t.push(day(k)); S.o.push(r.o ?? r.c); S.h.push(r.h ?? r.c); S.l.push(r.l ?? r.c); S.c.push(r.c);
    S.r2.push(r.r2 ?? 50); S.s200.push(r.s200 ?? 1); S.atr.push(r.atr ?? 1);
    S.idx.set(day(k), k);
  });
  return S;
}
const ctxOf = (cfg, map) => ({
  cfg, symbols: Object.keys(map), series: (s) => map[s], filters: () => null,
  openPrice: (s, t) => { const S = map[s]; const i = S?.idx.get(t); return i == null ? null : S.o[i]; },
  price: (s, t) => { const S = map[s]; const i = S?.idx.get(t); return i == null ? null : { px: S.o[i], time: t, late: false }; },
  isLate: () => false,
});

test('Nến 1h rồi nến 1m trong cùng giờ: không xử lý trùng; có lỗ hổng thì intradayNeed chỉ đúng phút còn thiếu', () => {
  const cfg = { ...base, capital: 1200, r3: { ...base.r3, enabled: false }, breakout: { ...base.breakout, minBars: 0, lookback: 3 } };
  const X = fakeSeries([{ c: 10, h: 10 }, { c: 10, h: 10 }, { c: 10, h: 10 }, { c: 12, h: 12, atr: 1 }, { o: 12, c: 12 }]);
  const btc = fakeSeries(Array.from({ length: 6 }, () => ({ c: 100, s200: 50 })));
  const ctx = ctxOf(cfg, { BTCUSDT: btc, XUSDT: X });
  const st = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) { openDay(st, day(k), ctx); closeDay(st, day(k), ctx); }
  openDay(st, day(4), ctx);
  assert.equal(intradayNeed(st, 'XUSDT'), day(4));
  const h1 = { t: day(4), o: 12, h: 12.5, l: 11.5, c: 12, ct: day(4) + HOUR - 1 };
  intraday(st, 'XUSDT', [h1], ctx);
  assert.equal(intradayNeed(st, 'XUSDT'), day(4) + HOUR);
  // a 1-minute bar inside the processed hour (e.g. delayed WebSocket) that would hit SL must be ignored
  const dup = { t: day(4) + 30 * MIN, o: 12, h: 12, l: 1, c: 12, ct: day(4) + 31 * MIN - 1 };
  assert.deepEqual(intraday(st, 'XUSDT', [dup], ctx), []);
  assert.equal(st.positions.length, 1);
});

test('R3: MFE/MAE cập nhật theo nến trong ngày (không ảnh hưởng luật thoát)', () => {
  const cfg = { ...base, capital: 1200, r3: { ...base.r3, minBars: 0 }, breakout: { ...base.breakout, enabled: false } };
  const X = fakeSeries([{ c: 100, r2: 55 }, { c: 100, r2: 40 }, { c: 100, r2: 20 }, { c: 100, r2: 5 }, { o: 100, c: 100, r2: 30 }]);
  const btc = fakeSeries(Array.from({ length: 6 }, () => ({ c: 100, s200: 50 })));
  const ctx = ctxOf(cfg, { BTCUSDT: btc, XUSDT: X });
  const st = newState(cfg, day(0));
  for (let k = 0; k <= 3; k++) { openDay(st, day(k), ctx); closeDay(st, day(k), ctx); }
  openDay(st, day(4), ctx);
  intraday(st, 'XUSDT', [{ t: day(4), o: 100, h: 106, l: 97, c: 100, ct: day(4) + MIN - 1 }], ctx);
  const p = st.positions[0];
  assert.ok(p.mfe > 0.05 && p.mae < -0.02, `${p.mfe} ${p.mae}`);
  assert.equal(st.positions.length, 1, 'R3 không có SL/TP trong ngày');
});

test('Chấm điểm tín hiệu: lợi nhuận sau N ngày so với rổ đều các coin', () => {
  const cfg = { ...base, capital: 1200, forwardHorizons: [1, 3], r3: { ...base.r3, minBars: 0 }, breakout: { ...base.breakout, enabled: false } };
  // X: R3 signal on day 3 (close 100), then 110 on day 4, 120 on day 6. Y flat 50 -> basket return = half of X's.
  const X = fakeSeries([{ c: 100, r2: 55 }, { c: 100, r2: 40 }, { c: 100, r2: 20 }, { c: 100, r2: 5 }, { c: 110 }, { c: 115 }, { c: 120 }]);
  const Y = fakeSeries(Array.from({ length: 7 }, () => ({ c: 50 })));
  const btc = fakeSeries(Array.from({ length: 7 }, () => ({ c: 100, s200: 50 })));
  const ctx = ctxOf(cfg, { BTCUSDT: btc, XUSDT: X, YUSDT: Y });
  const st = newState(cfg, day(0));
  const ev = [];
  for (let k = 0; k <= 6; k++) { ev.push(...openDay(st, day(k), ctx)); ev.push(...closeDay(st, day(k), ctx)); }
  const f = ev.filter((e) => e.type === 'signal_forward');
  assert.deepEqual(f.map((e) => e.h), [1, 3]);
  assert.ok(Math.abs(f[0].ret - 0.1) < 1e-12);
  // basket = average of BTC (0%), X (+10%), Y (0%) daily returns
  assert.ok(Math.abs(f[0].basket - 0.1 / 3) < 1e-12, String(f[0].basket));
  assert.equal(st.forward.length, 0, 'xong mốc cuối thì ngừng theo dõi');
  const stats = forwardStats([{ strategy: 'R3', forward: { 1: { ret: 0.1, basket: 0.02 } } }, { strategy: 'R3', forward: { 1: { ret: 0.0, basket: 0.02 } } }], [1]);
  const r = stats.find((x) => x.strategy === 'R3' && x.h === 1);
  assert.ok(Math.abs(r.avgExcess - 3) < 1e-9);
  assert.equal(r.beatPct, 50);
});

test('Đánh giá thử nghiệm: dưới 20 mẫu thì "chưa đủ", đủ mẫu thì so khoảng tin cậy với backtest', () => {
  const now = Date.UTC(2026, 11, 1);
  const mk = (k, n, right) => Array.from({ length: n }, (_, i) => ({ strategy: k, day: now - 10 * DAY, result: { ret: i < right ? 0.02 : -0.01 } }));
  const e1 = evaluation({ cfg: base, state: { createdAt: now - 7 * DAY }, trades: [], signals: mk('R3', 5, 4), forward: [], now });
  assert.match(e1.strategies[0].verdict, /Chưa đủ/);
  const e2 = evaluation({ cfg: base, state: { createdAt: now - 30 * DAY }, trades: [], signals: [...mk('R3', 40, 10), ...mk('BREAKOUT', 40, 15)], forward: [], now });
  assert.match(e2.strategies[0].verdict, /Kém hơn/); // 25% vs backtest 72.7%
  assert.match(e2.strategies[1].verdict, /Phù hợp/); // 37.5% vs 36.3%
  assert.match(e2.overall, /tạm dừng/);
});

test('Bảng "nếu đóng cửa bây giờ": ghép nến ngày đang chạy vào lịch sử để báo tín hiệu dự kiến', () => {
  const now = Date.UTC(2026, 10, 7, 12);
  const today = Date.UTC(2026, 10, 7);
  const closed = Array.from({ length: 40 }, (_, k) => ({ t: today - (40 - k) * DAY, o: 10, h: 10.2, l: 9.8, c: 10 }));
  const cache = new Map([['BTCUSDT', closed], ['LINKUSDT', closed]]);
  const liveDaily = { LINKUSDT: { t: today, o: 10, h: 11, l: 10, c: 10.9 }, BTCUSDT: { t: today, o: 10, h: 10.1, l: 9.9, c: 10 } };
  const w = watchlist({ cfg: base, cache, liveDaily, prices: { LINKUSDT: 10.9 }, now });
  const link = w.rows.find((r) => r.symbol === 'LINKUSDT');
  assert.equal(link.provisional, true);
  assert.equal(link.breakout, true);
  assert.equal(w.rows[0].symbol, 'LINKUSDT', 'coin có tín hiệu dự kiến đứng đầu');
});
