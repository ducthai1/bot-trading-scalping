import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/strategy.js';
import { ema } from '../src/indicators.js';
import { formatAlert } from '../src/format.js';

const base = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
// The 5-step geometry tests use a tiny synthetic swing whose TP1 cannot cover real fees,
// so the fee filter is off here and tested on its own below.
const cfg = { ...base, minNetRR: null };
const STEP = 180000;
const K = (i, o, h, l, c, v = 100) => ({ t: i * STEP, o, h, l, c, v, ct: i * STEP + STEP - 1 });

function trend(n, start, step) {
  const cs = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const c = p + step;
    cs.push(K(i, p, Math.max(p, c) + 5, Math.min(p, c) - 5, c));
    p = c;
  }
  return cs;
}

// Uptrend -> `pb` slow pullback candles -> green rejection candle dipping to EMA13.
function buildLong({ pb = 6, slExtra = 0, shockAt = -1 } = {}) {
  const cs = trend(80, 100000, 10);
  let p = cs[cs.length - 1].c;
  for (let j = 0; j < pb; j++) {
    const i = cs.length;
    if (j === shockAt) {
      const c = ema(cs.map((k) => k.c), 21).at(-1) - 40; // body pierces the whole ribbon
      cs.push(K(i, p, p + 2, c - 2, c, 1000));
      p = c;
      continue;
    }
    const c = p - 6;
    cs.push(K(i, p, p + 2, c - 2, c));
    p = c;
  }
  const kf = 2 / 14;
  const e13p = ema(cs.map((k) => k.c), 13).at(-1);
  const c = e13p + 10 / (1 - kf); // close 10 above EMA13 of this bar
  const e13n = e13p + kf * (c - e13p);
  const l = e13n - 1 - slExtra; // wick dips below EMA13
  cs.push(K(cs.length, l + 0.5, c + 0.5, l, c));
  return cs;
}

const reflect = (cs) => cs.map((k) => ({ ...k, o: 2e5 - k.o, h: 2e5 - k.l, l: 2e5 - k.h, c: 2e5 - k.c }));
const H1 = trend(100, 100000, 100);
const M15 = trend(100, 100000, 30);
const run = (candles, h1 = H1, m15 = M15, c = cfg) => evaluate({ h1, m15, candles, tf: '3m', cfg: c });

test('Long hợp lệ: đủ 5 bước -> có Entry/SL/TP1/TP2', () => {
  const r = run(buildLong());
  assert.ok(r.signal, r.reason);
  const s = r.signal;
  assert.equal(s.side, 'LONG');
  assert.equal(s.pbCount, 6);
  assert.equal(s.color, 'Xanh');
  const dist = s.entry - s.sl;
  assert.ok(dist >= cfg.slMin && dist <= cfg.slMax, `SL dist ${dist}`);
  assert.ok(s.tp1 > s.entry);
  assert.ok(s.tp2 > s.tp1 && s.tp2 % cfg.roundStep === 0);
});

test('Short hợp lệ (đối xứng)', () => {
  const long = run(buildLong()).signal;
  const r = run(reflect(buildLong()), reflect(H1), reflect(M15));
  assert.ok(r.signal, r.reason);
  const s = r.signal;
  assert.equal(s.side, 'SHORT');
  assert.equal(s.htfTrend, 'Downtrend');
  assert.equal(s.color, 'Đỏ');
  assert.ok(Math.abs(s.entry - (2e5 - long.entry)) <= 0.1);
  assert.ok(Math.abs(s.sl - (2e5 - long.sl)) <= 0.1);
  assert.ok(s.sl > s.entry && s.tp1 < s.entry);
  assert.ok(s.tp2 < s.tp1 && s.tp2 % cfg.roundStep === 0);
});

test('Đại cục sideway -> NO_SIGNAL', () => {
  const zig = Array.from({ length: 100 }, (_, i) => {
    const o = 100000 + (i % 2 ? 50 : -50);
    const c = 100000 + (i % 2 ? -50 : 50);
    return K(i, o, Math.max(o, c) + 5, Math.min(o, c) - 5, c);
  });
  const r = run(buildLong(), zig, M15);
  assert.ok(r.noSignal);
  assert.match(r.reason, /sideway/);
});

test('Đại cục không đồng pha -> NO_SIGNAL', () => {
  const r = run(buildLong(), H1, reflect(M15));
  assert.ok(r.noSignal);
  assert.match(r.reason, /không đồng pha/);
});

test('Pullback chỉ 3 nến -> NO_SIGNAL (chống FOMO)', () => {
  const r = run(buildLong({ pb: 3 }));
  assert.ok(r.noSignal);
  assert.match(r.reason, /Pullback 3/);
});

test('Sốc thanh khoản -> hủy kèo', () => {
  const r = run(buildLong({ shockAt: 2 }));
  assert.ok(r.noSignal);
  assert.match(r.reason, /Sốc thanh khoản/);
});

test('SL vượt 20 giá -> hủy kèo', () => {
  const r = run(buildLong({ slExtra: 22 }));
  assert.ok(r.noSignal);
  assert.match(r.reason, /^SL 35/);
});

test('Alert đúng template, đủ 4 mức giá', () => {
  const s = run(buildLong()).signal;
  const msg = formatAlert(s, cfg);
  for (const part of ['🚨', 'TÍN HIỆU LONG BTCUSDT - BINANCE', '⏱ Khung: 3m', 'Đại cục [15m]: Uptrend', 'Entry:', 'Stop-loss:', 'Take-profit 1', 'Take-profit 2', '22x Isolated']) {
    assert.ok(msg.includes(part), part);
  }
  assert.ok(msg.includes(s.entry.toFixed(1)) && msg.includes(s.sl.toFixed(1)));
});

test('R:R sau phí < minNetRR -> hủy kèo; bỏ phí thì R:R thô vẫn được tính', () => {
  const r = run(buildLong(), H1, M15, { ...base, minNetRR: 1 });
  assert.ok(r.noSignal);
  assert.match(r.reason, /^R:R sau phí/);
  const noFee = run(buildLong(), H1, M15, { ...base, minNetRR: 1, takerFee: 0, makerFee: 0 });
  assert.ok(noFee.signal, noFee.reason); // TP1 - Entry >= 1 x SL khi không có phí
});

// Uptrend -> 6 candles stalling at the top (never reach EMA8) -> one hammer stabbing into EMA13.
function buildStab() {
  const cs = trend(80, 100000, 10);
  const p = cs[cs.length - 1].c;
  for (let j = 0; j < 6; j++) cs.push(K(cs.length, p, p + 1, p - 1, p - 0.5));
  const e13 = ema(cs.map((k) => k.c), 13).at(-1);
  const l = e13 - 30; // well below this bar's EMA13 after the close pulls it up
  cs.push(K(cs.length, l + 14, l + 16, l, l + 15));
  return cs;
}

test('Nhịp hồi không về dải EMA, 1 nến cắm thẳng vào Killzone -> hủy kèo', () => {
  const off = run(buildStab(), H1, M15, { ...cfg, pullbackReachEma8: false });
  assert.ok(off.signal, off.reason);
  const on = run(buildStab(), H1, M15, { ...cfg, pullbackReachEma8: true });
  assert.ok(on.noSignal);
  assert.match(on.reason, /chưa tiến về dải EMA/);
});

test('SL < slMin: hủy mặc định, nới đủ slMin khi slWidenToMin', () => {
  const cs = buildLong();
  cs.pop();
  const c = ema(cs.map((k) => k.c), 13).at(-1) + 3; // low still pierces EMA13, but only 5 below close
  cs.push(K(cs.length, c - 4.5, c + 0.5, c - 5, c));
  const off = run(cs);
  assert.ok(off.noSignal);
  assert.match(off.reason, /^SL 7/);
  const on = run(cs, H1, M15, { ...cfg, slWidenToMin: true });
  assert.ok(on.signal, on.reason);
  assert.equal(on.signal.entry - on.signal.sl, cfg.slMin);
});

test('Nến xác nhận xanh xuyên cả dải EMA không bị coi là sốc thanh khoản', () => {
  const cs = buildLong();
  const k = cs[cs.length - 1];
  const e21 = ema(cs.map((x) => x.c), 21).at(-1);
  const c = k.c + 40;
  cs[cs.length - 1] = { ...k, o: e21 - 5, l: e21 - 6, c, h: c + 1, v: 10000 }; // huge green body, huge volume
  const closes = cs.map((x) => x.c);
  const top = Math.max(ema(closes, 8).at(-1), ema(closes, 13).at(-1), ema(closes, 21).at(-1));
  const bottom = Math.min(ema(closes, 8).at(-1), ema(closes, 13).at(-1), ema(closes, 21).at(-1));
  assert.ok(e21 - 5 < bottom && c > top, 'thân nến phải xuyên cả dải (luật cũ sẽ báo sốc)');
  const r = run(cs);
  assert.ok(!(r.reason || '').includes('Sốc thanh khoản'), r.reason);
});
