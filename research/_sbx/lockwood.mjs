// Thử nghiệm "Lockwood Scalp" theo mô tả bản gốc (bài review), chạy trên dữ liệu BTC cache.
//  H1: EMA8 > EMA21 và giá đóng > EMA8 (Long; Short ngược lại)
//  Khung bóp cò (mặc định 5m): EMA8 > EMA13 > EMA21; nến trigger chạm EMA8, không đóng dưới EMA21
//  Vào lệnh: Buy Stop ở đỉnh 5 nến gần nhất + buffer; SL: dưới đáy nến trigger - buffer
//  TP: 50% ở 1R, 50% ở 2R. 1 lệnh 1 lúc. Lệnh chờ huỷ sau WAIT nến nếu không khớp.
// node _sbx/lockwood.mjs [tf] [buffer_pct]
import { readFileSync } from 'node:fs';
import { ema } from '/app/src/indicators.js';

const TF = process.argv[2] || '5m';
const BUF = Number(process.argv[3] || 0.0003); // 3 pip EURUSD ≈ 0.028% giá
const WAIT = 5;
const QTY = 0.001;
const TK = Number(process.env.TAKER || 0.0005), MK = Number(process.env.MAKER || 0.0002);
const LONG_ONLY = !!process.env.LONG_ONLY;
const D = JSON.parse(readFileSync(process.env.DATA || '/app/_sbx/data/klines180.json', 'utf8'));
const F = D.futures;
const startT = D.end - D.days * 86400e3;
const cs = F[TF];
const h1 = F['1h'];
const c = cs.map((k) => k.c);
const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21);
const hc = h1.map((k) => k.c);
const h8 = ema(hc, 8), h21 = ema(hc, 21);

let hp = -1;
const h1At = (t) => {
  while (hp + 1 < h1.length && h1[hp + 1].ct <= t) hp++;
  return hp;
};

const trades = [];
let busyUntil = 0;
for (let i = 30; i < cs.length - 1; i++) {
  const k = cs[i];
  if (k.ct < startT || k.ct < busyUntil) continue;
  const j = h1At(k.ct);
  if (j < 30) continue;
  let side = null;
  if (h8[j] > h21[j] && hc[j] > h8[j] && e8[i] > e13[i] && e13[i] > e21[i] && k.l <= e8[i] && k.c >= e21[i]) side = 1;
  if (h8[j] < h21[j] && hc[j] < h8[j] && e8[i] < e13[i] && e13[i] < e21[i] && k.h >= e8[i] && k.c <= e21[i]) side = -1;
  if (!side || (LONG_ONLY && side < 0)) continue;
  const buf = k.c * BUF;
  const last5 = cs.slice(i - 4, i + 1);
  const entry = side > 0 ? Math.max(...last5.map((x) => x.h)) + buf : Math.min(...last5.map((x) => x.l)) - buf;
  const sl = side > 0 ? k.l - buf : k.h + buf;
  const R = Math.abs(entry - sl);
  const tp1 = entry + side * R, tp2 = entry + side * 2 * R;
  // wait for the stop order to fill
  let f = -1;
  for (let m = i + 1; m <= Math.min(i + WAIT, cs.length - 1); m++) {
    const b = cs[m];
    if (side > 0 ? b.l <= sl : b.h >= sl) break; // invalidated before entry
    if (side > 0 ? b.h >= entry : b.l <= entry) {
      f = m;
      break;
    }
  }
  if (f < 0) continue;
  // manage: SL fixed, 50% at 1R, 50% at 2R (worst case inside one candle: SL first)
  let half = false, pnl = 0, fees = entry * QTY * TK, res = 'timeout', m = f;
  for (; m < cs.length && m < f + 288; m++) {
    const b = cs[m];
    const hitSL = side > 0 ? b.l <= sl : b.h >= sl;
    if (hitSL) {
      const fr = half ? 0.5 : 1;
      pnl += side * (sl - entry) * fr;
      fees += sl * QTY * fr * TK;
      res = half ? 'TP1+SL' : 'SL';
      break;
    }
    if (!half && (side > 0 ? b.h >= tp1 : b.l <= tp1)) {
      half = true;
      pnl += side * (tp1 - entry) * 0.5;
      fees += tp1 * QTY * 0.5 * MK;
    }
    if (half && (side > 0 ? b.h >= tp2 : b.l <= tp2)) {
      pnl += side * (tp2 - entry) * 0.5;
      fees += tp2 * QTY * 0.5 * MK;
      res = 'TP1+TP2';
      break;
    }
  }
  if (res === 'timeout') {
    const last = cs[Math.min(m, cs.length - 1)].c, fr = half ? 0.5 : 1;
    pnl += side * (last - entry) * fr;
    fees += last * QTY * fr * TK;
  }
  busyUntil = cs[Math.min(m, cs.length - 1)].ct;
  trades.push({ t: cs[f].t, side, entry, R, res, rMult: pnl / R, gross: pnl * QTY, fees });
}

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const by = {};
for (const t of trades) by[t.res] = (by[t.res] || 0) + 1;
const Rs = trades.map((t) => t.R).sort((a, b) => a - b);
const gross = sum(trades, (t) => t.gross), fees = sum(trades, (t) => t.fees);
const fxCost = sum(trades, (t) => Math.abs(t.entry) * QTY * 0.00008); // chi phí kiểu EURUSD ECN: ~0.8 pip/vòng ≈ 0.008%
console.log(JSON.stringify({
  tf: TF,
  days: D.days,
  trades: trades.length,
  perDay: +(trades.length / D.days).toFixed(2),
  results: by,
  hitTP1pct: Math.round((trades.filter((t) => t.res !== 'SL' && t.res !== 'timeout').length / trades.length) * 100),
  slMedianUsdPts: Math.round(Rs[Math.floor(Rs.length / 2)]),
  slP25_P75: [Math.round(Rs[Math.floor(Rs.length * 0.25)]), Math.round(Rs[Math.floor(Rs.length * 0.75)])],
  avgR_beforeFees: +(sum(trades, (t) => t.rMult) / trades.length).toFixed(3),
  grossUsd: +gross.toFixed(2),
  binanceFeesUsd: +fees.toFixed(2),
  netUsd_Binance: +(gross - fees).toFixed(2),
  netUsd_ifForexLikeCost: +(gross - fxCost).toFixed(2),
}, null, 1));
