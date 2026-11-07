// Nghiên cứu R:R cố định: với mỗi loại tín hiệu, đặt SL = k×ATR dưới giá vào, TP = RR×SL phía trên.
// Đo xác suất chạm TP trước SL so với mức "đồng xu" 1/(1+RR), và R ròng sau phí (spot 0.1%/chiều + trượt giá).
// Đường đi giá mô phỏng bằng nến 4h; SL và TP cùng nằm trong 1 nến 4h -> tính SL trước (bất lợi).
import { readFileSync } from 'node:fs';
import { evaluate } from '/app/src/strategy.js';

const DAY = 86400e3, H4 = 4 * 3600e3;
const START = Date.UTC(2020, 0, 1);
const A = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const B = JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8'));
const OLD = Object.keys(A), DATA = { ...A, ...B }, SYMS = Object.keys(DATA);
const FEE = 0.001;
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : OLD.includes(s) ? 0.0005 : 0.0008);
const KS = [0.5, 1, 1.5, 2], RRS = [1, 1.5, 2, 3];
const MAXH = 60 * 6; // 60 days of 4h candles

const sma = (v, p) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; };
function rma(v, p) { const o = new Array(v.length).fill(NaN); let x; for (let i = 0; i < v.length; i++) { if (i === p - 1) x = v.slice(0, p).reduce((a, b) => a + b, 0) / p; else if (i >= p) x = (x * (p - 1) + v[i]) / p; o[i] = x; } return o; }
function rsi(c, p) { const g = [0], l = [0]; for (let i = 1; i < c.length; i++) { g.push(Math.max(c[i] - c[i - 1], 0)); l.push(Math.max(c[i - 1] - c[i], 0)); } const ag = rma(g, p), al = rma(l, p); return c.map((_, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]))); }
const atrOf = (k) => rma(k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l)), 14);
const toC = (rows, ms) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, ct: t + ms - 1 }));

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// ---- collect signals: { sym, t (entry time = open of next bar), atr } ----
const signals = { 'Ngẫu nhiên (mọi ngày)': [], 'Ngẫu nhiên khi giá > SMA200': [], 'R3 (Connors)': [], 'RSI(2)<5 (Connors)': [], 'Turtle: đóng cửa vượt đỉnh 20 ngày': [], 'EMA 8/13/21 bot md (khung 4h)': [] };
const mdCfg = { ...JSON.parse(readFileSync('/app/config.json', 'utf8')), slBuffer: 0, slMin: 0, slMax: 1e18, minNetRR: null };
const path = {};
for (const s of SYMS) {
  const d = toC(DATA[s]['1d'], DAY), h4 = toC(DATA[s]['4h'], H4);
  path[s] = { h4, at: new Map(h4.map((x, i) => [x.t, i])) };
  const c = d.map((x) => x.c), s200 = sma(c, 200), r2 = rsi(c, 2), a = atrOf(d);
  for (let i = 210; i < d.length - 1; i++) {
    const t = d[i + 1].t;
    if (t < START) continue;
    const sig = (name) => signals[name].push({ sym: s, t, atr: a[i] });
    if (rnd() < 0.05) sig('Ngẫu nhiên (mọi ngày)');
    if (c[i] > s200[i] && rnd() < 0.05) sig('Ngẫu nhiên khi giá > SMA200');
    if (c[i] > s200[i] && r2[i] < r2[i - 1] && r2[i - 1] < r2[i - 2] && r2[i - 2] < r2[i - 3] && r2[i - 3] < 60 && r2[i] < 10) sig('R3 (Connors)');
    if (c[i] > s200[i] && r2[i] < 5) sig('RSI(2)<5 (Connors)');
    if (c[i] > Math.max(...d.slice(i - 20, i).map((x) => x.h))) sig('Turtle: đóng cửa vượt đỉnh 20 ngày');
  }
  // bot md logic on 4h (trend from daily), LONG only
  const a4 = atrOf(h4);
  let hd = -1;
  for (let j = 300; j < h4.length - 1; j++) {
    if (h4[j + 1].t < START) continue;
    while (hd + 1 < d.length && d[hd + 1].ct < h4[j].ct + 1) hd++;
    if (hd < 60) continue;
    const big = d.slice(Math.max(0, hd - 299), hd + 1);
    const r = evaluate({ h1: big, m15: big, candles: h4.slice(j - 299, j + 1), tf: '4h', cfg: mdCfg });
    if (r.signal && r.signal.side === 'LONG') signals['EMA 8/13/21 bot md (khung 4h)'].push({ sym: s, t: h4[j + 1].t, atr: a4[j] });
  }
}

// ---- simulate one fixed-R:R trade on the 4h path ----
function trade(sig, k, rr) {
  const P = path[sig.sym], i0 = P.at.get(sig.t);
  if (i0 == null || !(sig.atr > 0)) return null;
  const slip = SLIP(sig.sym);
  const entry = P.h4[i0].o * (1 + slip), dist = k * sig.atr, sl = entry - dist, tp = entry + rr * dist;
  if (sl <= 0) return null;
  for (let i = i0; i < Math.min(P.h4.length, i0 + MAXH); i++) {
    const b = P.h4[i];
    if (b.l <= sl) return { hit: false, px: (i > i0 ? Math.min(sl, b.o) : sl) * (1 - slip), entry, dist };
    if (b.h >= tp) return { hit: true, px: tp, entry, dist };
  }
  const last = P.h4[Math.min(P.h4.length, i0 + MAXH) - 1];
  return { hit: null, px: last.c * (1 - slip), entry, dist };
}

const out = {};
for (const [name, list] of Object.entries(signals)) {
  const rows = [];
  for (const k of KS) {
    const row = { 'SL (×ATR)': k };
    for (const rr of RRS) {
      const T = list.map((s) => trade(s, k, rr)).filter(Boolean);
      const n = T.length, wins = T.filter((x) => x.hit === true).length;
      const hit = wins / n, base = 1 / (1 + rr);
      const netR = T.reduce((s, x) => s + ((x.px * (1 - FEE)) / (x.entry * (1 + FEE)) - 1) * (x.entry / x.dist), 0) / n;
      const z = (hit - base) / Math.sqrt((base * (1 - base)) / n);
      row[`1:${rr}`] = `${(hit * 100).toFixed(0)}% (${(base * 100).toFixed(0)}) ${netR >= 0 ? '+' : ''}${netR.toFixed(2)}R${Math.abs(z) >= 2.5 ? (z > 0 ? ' ▲' : ' ▼') : ''}`;
    }
    rows.push(row);
  }
  const slPct = list.slice(0, 2000).reduce((s, x) => { const P = path[x.sym]; const i = P.at.get(x.t); return i == null ? s : s + x.atr / P.h4[i].o; }, 0) / Math.min(list.length, 2000);
  console.log(`\n■ ${name} — ${list.length} tín hiệu (1 ATR ≈ ${(slPct * 100).toFixed(1)}% giá)`);
  console.table(rows);
}
console.log('\nĐọc ô: "chạm TP% (mức đồng xu%) R ròng sau phí". ▲ = cao hơn đồng xu rõ rệt (z ≥ 2.5), ▼ = thấp hơn rõ rệt.');
