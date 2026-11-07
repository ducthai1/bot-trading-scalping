// Replay dữ liệu cache qua evaluate() của repo, mô phỏng lệnh (có phí), đo các nghi vấn.
// node _sbx/analyze.mjs [label]
import { readFileSync, existsSync } from 'node:fs';
import { evaluate } from '/app/src/strategy.js';
import { ema, atr } from '/app/src/indicators.js';

const label = process.argv[2] || 'run';
const D = JSON.parse(readFileSync(process.env.DATA || '/app/_sbx/data/klines.json', 'utf8'));
const cfg = Object.assign(JSON.parse(readFileSync('/app/config.json', 'utf8')), JSON.parse(process.env.CFG || '{}'));
const F = D.futures;
const WIN = 300;
const QTY = 0.001; // minQty BTCUSDT
const TAKER = cfg.takerFee ?? 0.0005;
const MAKER = cfg.makerFee ?? 0.0002;
const startT = D.end - D.days * 86400e3;

// Optional cross-TF gate (exists only after the fix).
let Gate = null;
if (existsSync('/app/src/signal-gate.js')) Gate = (await import('/app/src/signal-gate.js')).SignalGate;

function cursor(arr) {
  let p = -1;
  return (t) => {
    while (p + 1 < arr.length && arr[p + 1].ct <= t) p++;
    return p;
  };
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * q)] : NaN);

// ---- replay ----
const events = []; // {tf, t, r, candles}
const reasons = {};
const slSplit = { lt: 0, gt: 0 };
let shockOnConfirm = 0;
let shockTotal = 0;
for (const tf of cfg.triggerTimeframes) {
  const cs = F[tf];
  const at1 = cursor(F['1h']);
  const at15 = cursor(F['15m']);
  for (let i = WIN; i < cs.length; i++) {
    if (cs[i].ct < startT) continue;
    const t = cs[i].ct;
    const p1 = at1(t);
    const p15 = at15(t);
    const candles = cs.slice(i - WIN + 1, i + 1);
    const r = evaluate({
      h1: F['1h'].slice(Math.max(0, p1 - WIN + 1), p1 + 1),
      m15: F['15m'].slice(Math.max(0, p15 - WIN + 1), p15 + 1),
      candles,
      tf,
      cfg,
    });
    if (r.noSignal) {
      const key = r.reason.replace(/(?<![A-Za-z\d])-?\d+(\.\d+)?(?![Hm\d])/g, '#');
      reasons[key] = (reasons[key] || 0) + 1;
      const m = r.reason.match(/^SL (-?[\d.]+)/);
      if (m) Number(m[1]) < cfg.slMin ? slSplit.lt++ : slSplit.gt++;
      if (/Sốc thanh khoản/.test(r.reason)) {
        shockTotal++;
        // Is the confirmation candle (n) itself the "shock" candle? (body-spans-ribbon is symmetric for long/short)
        const n = candles.length - 1;
        const c = candles.map((k) => k.c);
        const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21);
        const lo = Math.min(e8[n], e13[n], e21[n]), hi = Math.max(e8[n], e13[n], e21[n]);
        const k = candles[n];
        let s = 0;
        for (let j = n - 20; j < n; j++) s += candles[j].v;
        if (Math.min(k.o, k.c) < lo && Math.max(k.o, k.c) > hi && k.v > cfg.shockVolMult * (s / 20)) shockOnConfirm++;
      }
    } else if (!process.env.LONG_ONLY || r.signal.side === 'LONG') {
      events.push({ tf, t, r, candles });
    }
  }
}

// Dedupe by key like live (sent Set), then sort chronologically.
const seen = new Set();
let sigs = [];
for (const e of events.sort((a, b) => a.t - b.t)) {
  if (seen.has(e.r.signal.key)) continue;
  seen.add(e.r.signal.key);
  sigs.push(e);
}
const rawCount = sigs.length;
let gated = 0;
if (Gate) {
  const g = new Gate(cfg);
  sigs = sigs.filter((e) => (g.allow(e.r.signal, e.t + 1) ? true : (gated++, false)));
}

// ---- simulate on 3m candles ----
const m3 = F['3m'];
const idx3 = cursor(m3);
function simulate(s, t) {
  const long = s.side === 'LONG';
  const dir = long ? 1 : -1;
  let i = idx3(t) + 1;
  let half = false;
  let sl = s.sl;
  let pnl = 0; // price points * qty fraction
  let fees = s.entry * QTY * TAKER;
  const end = t + 8 * 3600e3;
  for (; i < m3.length && m3[i].t < end; i++) {
    const k = m3[i];
    const hitSL = long ? k.l <= sl : k.h >= sl;
    const hitTP1 = !half && (long ? k.h >= s.tp1 : k.l <= s.tp1);
    if (hitSL) {
      const frac = half ? 0.5 : 1;
      pnl += dir * (sl - s.entry) * frac;
      fees += sl * QTY * frac * TAKER;
      return { res: half ? 'TP1+BE' : 'SL', pnl, fees, bars: i };
    }
    if (hitTP1) {
      half = true;
      pnl += dir * (s.tp1 - s.entry) * 0.5;
      fees += s.tp1 * QTY * 0.5 * MAKER;
      sl = s.entry;
      if (long ? k.l <= sl : k.h >= sl) {
        fees += sl * QTY * 0.5 * TAKER;
        return { res: 'TP1+BE', pnl, fees };
      }
    }
    if (half && (long ? k.h >= s.tp2 : k.l <= s.tp2)) {
      pnl += dir * (s.tp2 - s.entry) * 0.5;
      fees += s.tp2 * QTY * 0.5 * MAKER;
      return { res: 'TP1+TP2', pnl, fees };
    }
  }
  const last = m3[Math.min(i, m3.length - 1)].c;
  const frac = half ? 0.5 : 1;
  pnl += dir * (last - s.entry) * frac;
  fees += last * QTY * frac * TAKER;
  return { res: half ? 'TP1+timeout' : 'timeout', pnl, fees };
}

if (process.env.LIST) for (const e of sigs) console.error(new Date(e.t + 1).toISOString().slice(0, 16), e.tf, e.r.signal.side, "entry", e.r.signal.entry, "sl", e.r.signal.sl, "tp1", e.r.signal.tp1, "pb", e.r.signal.pbCount, "EMA", e.r.signal.touchedEma);
const out = { label, signals: sigs.length, rawSignals: rawCount, gated, byTf: {}, results: {}, grossUsd: 0, feesUsd: 0 };
const rr = [];
const slDist = [];
let rrBelow1 = 0;
let noApproach = 0;
let crossTfDup = 0;
for (let a = 0; a < sigs.length; a++) {
  const { tf, t, r, candles } = sigs[a];
  const s = r.signal;
  out.byTf[tf] = (out.byTf[tf] || 0) + 1;
  const risk = Math.abs(s.entry - s.sl);
  const reward = Math.abs(s.tp1 - s.entry);
  rr.push(reward / risk);
  slDist.push(risk);
  if (reward < risk) rrBelow1++;
  // Pullback reached the ribbon before the confirmation candle?
  const sIdx = candles.findIndex((k) => `${tf}:${s.side}:${k.t}` === s.key);
  if (sIdx >= 0) {
    const c = candles.map((k) => k.c);
    const e8 = ema(c, 8);
    const n = candles.length - 1;
    let reached = false;
    for (let j = sIdx + 1; j < n; j++) {
      if (s.side === 'LONG' ? candles[j].l <= e8[j] : candles[j].h >= e8[j]) reached = true;
    }
    if (!reached) noApproach++;
  }
  for (let b = a - 1; b >= 0 && t - sigs[b].t <= 15 * 60e3; b--) {
    if (sigs[b].tf !== tf && sigs[b].r.signal.side === s.side) {
      crossTfDup++;
      break;
    }
  }
  const sim = simulate(s, t);
  out.results[sim.res] = (out.results[sim.res] || 0) + 1;
  out.grossUsd += sim.pnl * QTY;
  out.feesUsd += sim.fees;
}
out.netUsd = out.grossUsd - out.feesUsd;
out.rrMedian = median(rr);
out.rrBelow1 = rrBelow1;
out.slDistMedian = median(slDist);
out.pullbackNotReachingEma8BeforeConfirm = noApproach;
out.crossTfDupWithin15m = crossTfDup;
out.slRejects = slSplit;
out.shock = { total: shockTotal, confirmationCandleIsShock: shockOnConfirm };

// Market context
const a3 = atr(m3, 14).filter((x) => x > 0 && !Number.isNaN(x));
const a5 = atr(F['5m'], 14).filter((x) => x > 0 && !Number.isNaN(x));
out.atr = { m3_median: +median(a3).toFixed(1), m3_p25: +pct(a3, 0.25).toFixed(1), m5_median: +median(a5).toFixed(1) };
const sp = new Map(D.spot3m.map((k) => [k.t, k.c]));
const basis = m3.filter((k) => sp.has(k.t)).map((k) => k.c - sp.get(k.t));
out.basisFutMinusSpot = { n: basis.length, median: +median(basis).toFixed(1), absP90: +pct(basis.map(Math.abs), 0.9).toFixed(1), absMax: +Math.max(...basis.map(Math.abs)).toFixed(1) };
out.priceNow = m3.at(-1).c;
out.notionalPerMinQty = +(m3.at(-1).c * QTY).toFixed(2);
out.capitalTimesLev = +(cfg.capital * cfg.leverage).toFixed(2);
out.filters = D.filters;
out.reasons = Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]));
for (const k of ['grossUsd', 'feesUsd', 'netUsd', 'rrMedian', 'slDistMedian']) out[k] = +out[k].toFixed(3);
console.log(JSON.stringify(out, null, 2));
