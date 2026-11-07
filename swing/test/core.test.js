import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sma, rsi, atr } from '../src/indicators.js';
import { buildSeries, r3Entry, breakoutEntry } from '../src/strategy.js';
import { createStore } from '../src/store.js';
import { dailyDue, nextDailyAt } from '../src/schedule.js';
import { wilson, tradeStats, toCSV } from '../src/report.js';
import { persistEvents, loadHistory } from '../src/history.js';
import { simulate, summarize } from '../src/sim.js';
import { floorStep, stepDecimals, DAY, MIN } from '../src/util.js';
import { validate, loadEnv } from '../src/config.js';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Chỉ báo: SMA, RSI Wilder (tính tay), ATR', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2).slice(1), [1.5, 2.5, 3.5]);
  // closes 10, 11, 10.5, 12 ; gains [0,1,0,1.5] losses [0,0,0.5,0]
  // RSI(2): seed at i=1 avg(g0,g1)=0.5, avg(l0,l1)=0 -> 100 ; i=2: ag=.25, al=.25 -> 50 ; i=3: ag=.875, al=.125 -> 87.5
  const r = rsi([10, 11, 10.5, 12], 2);
  near(r[1], 100);
  near(r[2], 50);
  near(r[3], 87.5);
  const a = atr([{ h: 2, l: 1, c: 1.5 }, { h: 3, l: 1.5, c: 2 }, { h: 2.5, l: 2, c: 2.2 }], 2);
  near(a[1], (1 + 1.5) / 2);
  near(a[2], (1.25 * 1 + 0.5) / 2);
});

test('Luật R3 và Breakout trên chuỗi giá dựng sẵn', () => {
  // 230 days of steady rise, then 4 down days -> R3 entry on the last one
  const k = [];
  let p = 100;
  for (let i = 0; i < 230; i++) k.push({ t: i * DAY, o: p, h: p * 1.01, l: p * 0.99, c: (p *= 1.004) });
  for (let i = 0; i < 4; i++) k.push({ t: (230 + i) * DAY, o: p, h: p, l: p * 0.97, c: (p *= 0.975) });
  const S = buildSeries(k);
  const n = k.length - 1;
  assert.ok(S.r2[n - 3] < 60 && S.r2[n] < 10, `r2 ${S.r2.slice(n - 3, n + 1).map((x) => x.toFixed(1))}`);
  assert.equal(r3Entry(S, n, { ...base.r3 }), true);
  assert.equal(r3Entry(S, n - 1, { ...base.r3 }), false);
  assert.equal(r3Entry(S, n, { ...base.r3, minBars: 500 }), false, 'chưa đủ lịch sử');
  // breakout: flat 40 days then a close above the 20-day high
  const f = Array.from({ length: 40 }, (_, i) => ({ t: i * DAY, o: 10, h: 10.2, l: 9.8, c: 10 }));
  f.push({ t: 40 * DAY, o: 10, h: 10.6, l: 10, c: 10.5 });
  const F = buildSeries(f);
  assert.equal(breakoutEntry(F, 40, base.breakout), true);
  assert.equal(breakoutEntry(F, 39, base.breakout), false);
});

test('Làm tròn khối lượng xuống đúng bước lot của Binance', () => {
  assert.equal(stepDecimals('0.00100000'), 3);
  assert.equal(stepDecimals('1.00000000'), 0);
  assert.equal(floorStep(1.23456, '0.00100000'), 1.234);
  assert.equal(floorStep(0.0009999, '0.00100000'), 0);
  assert.equal(floorStep(5.99999, '1.00000000'), 5);
  assert.equal(floorStep(0.3, '0.1'), 0.3, 'không bị lỗi số thực 0.3/0.1 = 2.999…');
});

test('Lưu trữ: ghi nguyên tử, khôi phục từ .bak khi file hỏng, đọc JSONL bỏ qua dòng hỏng, khoá tiến trình', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'swing-'));
  try {
    const st = createStore(dir);
    st.saveState({ a: 1 });
    st.saveState({ a: 2 });
    assert.deepEqual(st.loadState(), { a: 2 });
    writeFileSync(path.join(dir, 'state.json'), '{"a":'); // torn write
    assert.deepEqual(st.loadState(), { a: 1 }, 'lấy bản .bak');
    st.append('x.jsonl', [{ i: 1 }, { i: 2 }]);
    appendFileSync(path.join(dir, 'x.jsonl'), '{"i":3');
    assert.deepEqual(st.readJSONL('x.jsonl'), [{ i: 1 }, { i: 2 }]);
    assert.equal(st.acquireLock(), true);
    assert.equal(createStore(dir).acquireLock(), true, 'cùng PID được lấy lại khoá');
    writeFileSync(path.join(dir, 'bot.lock'), String(process.ppid)); // a live foreign process
    assert.equal(st.acquireLock(), false, 'tiến trình khác đang giữ khoá');
    writeFileSync(path.join(dir, 'bot.lock'), '999999'); // dead pid
    assert.equal(st.acquireLock(), true, 'khoá cũ của tiến trình đã chết được thu hồi');
    st.releaseLock();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Lịch chạy: job ngày đến hạn sau 00:00 UTC + vài phút, chạy bù khi lỡ ngày', () => {
  const cfg = base;
  const today = Date.UTC(2026, 10, 7);
  const st = { lastClosedDay: today - 2 * DAY, lastOpenedDay: today - DAY };
  assert.equal(dailyDue(today + 1 * MIN, st, cfg), false, 'đợi Binance chốt nến');
  assert.equal(dailyDue(today + 3 * MIN, st, cfg), true);
  assert.equal(dailyDue(today + 3 * MIN, { lastClosedDay: today - DAY, lastOpenedDay: today }, cfg), false, 'đã chạy hôm nay');
  assert.equal(dailyDue(today + 10 * 3600e3, { lastClosedDay: today - 5 * DAY, lastOpenedDay: today - 4 * DAY }, cfg), true, 'lỡ nhiều ngày');
  assert.equal(nextDailyAt(today + 3 * MIN, cfg), today + DAY + 2 * MIN);
});

test('Báo cáo: khoảng tin cậy Wilson, thống kê lệnh, CSV escape', () => {
  const [lo, hi] = wilson(7, 10);
  assert.ok(lo > 39 && lo < 40 && hi > 89 && hi < 90, `${lo} ${hi}`);
  const s = tradeStats([{ ret: 0.1, pnl: 1, days: 2 }, { ret: -0.05, pnl: -0.5, days: 4 }]);
  near(s.win, 50);
  near(s.pf, 2);
  near(s.avgRet, 2.5);
  assert.equal(toCSV([{ a: 'x,"y"' }], [['a', (r) => r.a]]), 'a\n"x,""y"""\n');
});

test('Lịch sử: chạy lại một ngày sau sự cố không tạo dòng trùng', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'swing-'));
  try {
    const st = createStore(dir);
    const evs = [
      { type: 'signal', id: 'S1', day: 1, strategy: 'R3', symbol: 'X' },
      { type: 'signal_update', id: 'S1', status: 'taken', reason: null },
      { type: 'trade_close', trade: { id: 'P1', exitTime: 5, pnl: 1, ret: 0.1 } },
      { type: 'equity', t: 1, equity: 100 },
    ];
    persistEvents(st, evs);
    persistEvents(st, evs); // crash before state was saved -> same day processed again
    persistEvents(st, [{ type: 'signal_result', id: 'S1', ret: 0.2 }]);
    const h = loadHistory(st);
    assert.equal(h.trades.length, 1);
    assert.equal(h.equity.length, 1);
    assert.equal(h.signals.length, 1);
    assert.equal(h.signals[0].status, 'taken');
    assert.equal(h.signals[0].result.ret, 0.2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cấu hình: báo khi vốn quá nhỏ, chặn cấu hình sai; đọc .env', () => {
  assert.match(validate({ ...base, capital: 30 }), /tối thiểu/);
  assert.equal(validate({ ...base, capital: 100 }), null);
  assert.throws(() => validate({ ...base, slotsTotal: 6 }), /slotsTotal/);
  assert.throws(() => validate({ ...base, coins: ['ETHUSDT'] }), /BTCUSDT/);
  const dir = mkdtempSync(path.join(tmpdir(), 'swing-'));
  try {
    writeFileSync(path.join(dir, '.env'), '# c\nSWING_T1="a b" # x\nexport SWING_T2=c\n');
    loadEnv(path.join(dir, '.env'));
    assert.equal(process.env.SWING_T1, 'a b');
    assert.equal(process.env.SWING_T2, 'c');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Mô phỏng đầy đủ trên dữ liệu ngẫu nhiên: sổ sách luôn cân (tiền + coin = vốn), không NaN', () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const cfg = { ...base, coins: ['BTCUSDT', 'AUSDT', 'BUSDT', 'CUSDT'], capital: 1000 };
  const daily = {}, intra = {};
  for (const s of cfg.coins) {
    let p = 100;
    daily[s] = [];
    intra[s] = [];
    for (let i = 0; i < 700; i++) {
      const t = Date.UTC(2020, 0, 1) + i * DAY;
      const o = p;
      const path6 = [o];
      for (let h = 0; h < 6; h++) path6.push((p *= 1 + (rnd() - 0.48) * 0.04));
      for (let h = 0; h < 6; h++) {
        const a = path6[h], b = path6[h + 1];
        intra[s].push({ t: t + h * 4 * 3600e3, o: a, h: Math.max(a, b) * 1.003, l: Math.min(a, b) * 0.997, c: b, ct: t + (h + 1) * 4 * 3600e3 - 1 });
      }
      const bars = intra[s].slice(-6);
      daily[s].push({ t, o, h: Math.max(...bars.map((x) => x.h)), l: Math.min(...bars.map((x) => x.l)), c: p });
    }
  }
  const r = simulate({ cfg, daily, intraday: intra, from: Date.UTC(2020, 8, 1) });
  const st = r.state;
  const value = st.positions.reduce((a, p) => a + p.qty * p.lastPx, 0);
  near(st.cash + value, st.equity, 1e-6);
  assert.ok(r.trades.length > 0, 'có lệnh');
  for (const t of r.trades) assert.ok(Number.isFinite(t.ret) && Number.isFinite(t.pnl), JSON.stringify(t));
  const pnl = r.trades.reduce((a, t) => a + t.pnl, 0) + st.positions.reduce((a, p) => a + (p.qty * p.lastPx - p.cost), 0);
  near(cfg.capital + pnl, st.equity, 1e-6);
  const s = summarize(r);
  assert.ok(Number.isFinite(s.cagr) && Number.isFinite(s.maxDD));
  assert.ok(st.cash >= -1e-9, 'không bao giờ âm tiền');
});
