// R3 (Connors & Alvarez) — danh mục spot 34 coin: (1) độ trễ vào/ra lệnh, (2) các cách giảm lỗ.
// Tín hiệu trên nến ngày; khớp lệnh bằng giá mở của nến 4h tại thời điểm (00:00 UTC + trễ).
import { readFileSync } from 'node:fs';

const DAY = 86400e3, H = 3600e3;
const START = Date.UTC(2020, 0, 1), MID = Date.UTC(2023, 0, 1);
const A = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const B = JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8'));
const OLD = Object.keys(A), NEW = Object.keys(B);
const DATA = { ...A, ...B }, SYMS = [...OLD, ...NEW];
const FEE = 0.001;
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : OLD.includes(s) ? 0.0005 : 0.0008);

const sma = (v, p) => { const o = new Array(v.length).fill(NaN); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= p) s -= v[i - p]; if (i >= p - 1) o[i] = s / p; } return o; };
function rma(v, p) { const o = new Array(v.length).fill(NaN); let x; for (let i = 0; i < v.length; i++) { if (i === p - 1) x = v.slice(0, p).reduce((a, b) => a + b, 0) / p; else if (i >= p) x = (x * (p - 1) + v[i]) / p; o[i] = x; } return o; }
function rsi(c, p) { const g = [0], l = [0]; for (let i = 1; i < c.length; i++) { g.push(Math.max(c[i] - c[i - 1], 0)); l.push(Math.max(c[i - 1] - c[i], 0)); } const ag = rma(g, p), al = rma(l, p); return c.map((_, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]))); }

const S = {};
for (const s of SYMS) {
  const k = DATA[s]['1d'].map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const c = k.map((x) => x.c);
  const tr = k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));
  const atr = rma(tr, 20);
  S[s] = { k, c, s200: sma(c, 200), r2: rsi(c, 2), atrPct: atr.map((a, i) => a / c[i]), idx: new Map(k.map((x, i) => [x.t, i])), o4: new Map(DATA[s]['4h'].map((x) => [x[0], x[1]])) };
}
const btc = S.BTCUSDT;
const days = [...new Set(SYMS.flatMap((s) => S[s].k.map((x) => x.t)))].filter((t) => t >= START).sort((a, b) => a - b);
const entrySig = (X, i) => i > 210 && X.c[i] > X.s200[i] && X.r2[i] < X.r2[i - 1] && X.r2[i - 1] < X.r2[i - 2] && X.r2[i - 2] < X.r2[i - 3] && X.r2[i - 3] < 60 && X.r2[i] < 10;
const exitSig = (X, i) => X.r2[i] > 70;
// price at (day t open + delay hours): open of the 4h candle starting then (falls back to the daily open)
const px = (X, t, delay) => X.o4.get(t + delay * H) ?? (delay === 0 ? X.k[X.idx.get(t)].o : null);

function run(o = {}) {
  const { K = 6, delay = 0, volSize = false, timeStop = 0, btcFilter = false, stopPct = 0, maxNew = Infinity } = o;
  const medAtr = (t) => { const v = SYMS.map((s) => { const i = S[s].idx.get(t); return i != null ? S[s].atrPct[i] : NaN; }).filter((x) => x > 0).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  let cash = 1, eqPrev = 1, peak = 1, dd = 0;
  const pos = new Map(), log = [], yearEq = {}, curve = [];
  let wantIn = [], wantOut = new Set();
  const val = (t) => cash + [...pos].reduce((s, [sym, p]) => { const i = S[sym].idx.get(t); return s + p.q * (i != null ? S[sym].c[i] : p.px); }, 0);
  const close = (sym, price, t) => { const p = pos.get(sym); const e = price * (1 - SLIP(sym)); cash += p.q * e * (1 - FEE); log.push({ sym, old: OLD.includes(sym), t: p.t, days: Math.round((t - p.t) / DAY), ret: (e * (1 - FEE)) / (p.px * (1 + FEE)) - 1 }); pos.delete(sym); };
  for (const t of days) {
    for (const sym of wantOut) { if (!pos.has(sym)) continue; const p = px(S[sym], t, delay); if (p != null) close(sym, p, t); }
    wantOut = new Set();
    let opened = 0;
    for (const { sym } of wantIn.sort((a, b) => a.r - b.r)) {
      if (pos.has(sym) || pos.size >= K || opened >= maxNew) continue;
      const X = S[sym], i = X.idx.get(t);
      const p0 = px(X, t, delay);
      if (i == null || p0 == null) continue;
      let w = 1;
      if (volSize) w = Math.min(1, medAtr(t) / X.atrPct[i - 1]);
      const alloc = Math.min((eqPrev / K) * w, cash / (1 + FEE));
      if (alloc <= 0) continue;
      const e = p0 * (1 + SLIP(sym));
      pos.set(sym, { q: alloc / e, px: e, t, stop: stopPct ? e * (1 - stopPct) : 0 });
      cash -= alloc * (1 + FEE);
      opened++;
    }
    wantIn = [];
    for (const [sym, p] of [...pos]) { // intraday disaster stop (from the day after entry)
      const i = S[sym].idx.get(t);
      if (p.stop && i != null && t > p.t && S[sym].k[i].l <= p.stop) close(sym, Math.min(p.stop, S[sym].k[i].o), t);
    }
    const eq = val(t);
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); eqPrev = eq;
    yearEq[new Date(t).getUTCFullYear()] = eq;
    curve.push([t, eq]);
    const bi = btc.idx.get(t);
    const btcOk = !btcFilter || (bi != null && btc.c[bi] > btc.s200[bi]);
    for (const sym of SYMS) {
      const X = S[sym], i = X.idx.get(t);
      if (i == null) continue;
      if (pos.has(sym)) { if (exitSig(X, i) || (timeStop && (t - pos.get(sym).t) / DAY >= timeStop)) wantOut.add(sym); }
      else if (btcOk && entrySig(X, i)) wantIn.push({ sym, r: X.r2[i] });
    }
  }
  const years = (days.at(-1) - days[0]) / (365.25 * DAY);
  let prev = 1;
  const yr = Object.values(yearEq).map((e) => { const r = (e / prev - 1) * 100; prev = e; return r; });
  const cell = (old, early) => { const a = log.filter((x) => x.old === old && (early ? x.t < MID : x.t >= MID)); return a.reduce((s, x) => s + x.ret, 0) / a.length * 100; };
  const avg = (a) => a.reduce((s, x) => s + x.ret, 0) / a.length * 100;
  return {
    curve, log, n: log.length, perWeek: log.length / years / 52, win: (log.filter((x) => x.ret > 0).length / log.length) * 100, exp: avg(log),
    worst: Math.min(...log.map((x) => x.ret)) * 100, cagr: (val(days.at(-1)) ** (1 / years) - 1) * 100, dd: dd * 100, worstYear: Math.min(...yr),
    cells: [cell(true, true), cell(true, false), cell(false, true), cell(false, false)],
  };
}

const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
const row = (label, r) => ({ 'cấu hình': label, 'lệnh/tuần': f1(r.perWeek), 'thắng %': f1(r.win), 'kỳ vọng %': f2(r.exp), 'tệ nhất %': f1(r.worst), '%/năm': f1(r.cagr), 'sụt max %': f1(r.dd), 'năm tệ nhất %': f1(r.worstYear), '4 ô kiểm chứng (cũ20-22/cũ23-26/mới20-22/mới23-26)': r.cells.map(f2).join(' / '), 'cả 4 dương': r.cells.every((x) => x > 0) ? '✅' : '❌' });

if (process.env.MODE === 'hold') {
  const r = run();
  const groups = [[1, 2], [3, 5], [6, 9], [10, 14], [15, 99]];
  console.table(groups.map(([a, b]) => { const g = r.log.filter((x) => x.days >= a && x.days <= b); return { 'giữ (ngày)': `${a}-${b === 99 ? '…' : b}`, lệnh: g.length, 'thắng %': f1((g.filter((x) => x.ret > 0).length / g.length) * 100), 'kỳ vọng %': f2(g.reduce((s, x) => s + x.ret, 0) / g.length * 100) }; }));
} else if (process.env.MODE === 'log') {
  process.stdout.write(JSON.stringify(run({ K: 6, maxNew: 2, btcFilter: true }).log.map((x) => [x.sym, x.t, +x.ret.toFixed(5), x.days])), () => process.exit(0));
} else if (process.env.MODE === 'curve') {
  console.log(JSON.stringify(run({ K: 6, maxNew: 2, btcFilter: true }).curve));
} else if (process.env.MODE === 'money') {
  const r = run({ K: 6, maxNew: 2, btcFilter: true });
  const C = r.curve;
  const bucket = (keyOf) => { const m = new Map(); for (const [t, e] of C) { const k = keyOf(t); if (!m.has(k)) m.set(k, [e, e]); m.get(k)[1] = e; } const out = []; let prev = 1; for (const [, [, end]] of m) { out.push((end / prev - 1) * 100); prev = end; } return out; };
  const weeks = bucket((t) => Math.floor((t - 4 * DAY) / (7 * DAY)));
  { const keys = [...new Set(C.map(([t]) => Math.floor((t - 4 * DAY) / (7 * DAY))))]; const lo = weeks.indexOf(Math.min(...weeks)), hi = weeks.indexOf(Math.max(...weeks));
    const wk = (k) => new Date(keys[k] * 7 * DAY + 4 * DAY).toISOString().slice(0, 10);
    console.error(`tuần tệ nhất bắt đầu ${wk(lo)}: ${weeks[lo].toFixed(2)}% | tuần tốt nhất bắt đầu ${wk(hi)}: ${weeks[hi].toFixed(2)}%`);
    for (const [k] of [[lo], [hi]]) { const st = keys[k] * 7 * DAY + 4 * DAY; console.error('  lệnh mở/đóng quanh tuần này:', r.log.filter((x) => x.t >= st - 14 * DAY && x.t < st + 7 * DAY).map((x) => `${x.sym.replace('USDT', '')} ${new Date(x.t).toISOString().slice(5, 10)} ${(x.ret * 100).toFixed(1)}%`).join(', ')); } }
  const months = bucket((t) => new Date(t).toISOString().slice(0, 7));
  const years = bucket((t) => new Date(t).getUTCFullYear());
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const desc = (a) => ({ n: a.length, mean: a.reduce((s, x) => s + x, 0) / a.length, pos: a.filter((x) => x > 0.01).length / a.length * 100, neg: a.filter((x) => x < -0.01).length / a.length * 100, p10: q(a, 0.1), p50: q(a, 0.5), p90: q(a, 0.9), min: Math.min(...a), max: Math.max(...a) });
  // drawdown duration
  let peak = 0, peakT = C[0][0], longest = 0;
  for (const [t, e] of C) { if (e >= peak) { longest = Math.max(longest, (t - peakT) / DAY); peak = e; peakT = t; } }
  longest = Math.max(longest, (C.at(-1)[0] - peakT) / DAY);
  // bootstrap 1-year outcomes from the trade list (each trade uses 1/6 of equity)
  const rets = r.log.map((x) => x.ret), perYear = Math.round(r.n / ((C.at(-1)[0] - C[0][0]) / (365.25 * DAY)));
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const sim = (shift) => { const out = []; for (let k = 0; k < 10000; k++) { let e = 1; for (let j = 0; j < perYear; j++) e *= 1 + (rets[Math.floor(rnd() * rets.length)] + shift) / 6; out.push((e - 1) * 100); } return out; };
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const real = sim(0), noEdge = sim(-mean - 0.003); // edge gone: price move averages 0, only fees+slippage (~0.3%/trade) remain
  console.log(JSON.stringify({ trades: r.n, perYear, cagr: r.cagr, dd: r.dd, longestDrawdownDays: Math.round(longest), weeks: desc(weeks), months: desc(months), years: years.map((x) => +x.toFixed(1)),
    boot: { p5: q(real, 0.05), p25: q(real, 0.25), p50: q(real, 0.5), p75: q(real, 0.75), p95: q(real, 0.95), lossProb: real.filter((x) => x < 0).length / 100 },
    noEdge: { p5: q(noEdge, 0.05), p50: q(noEdge, 0.5), p95: q(noEdge, 0.95), lossProb: noEdge.filter((x) => x < 0).length / 100 } }));
} else if (process.env.MODE === 'robust') {
  const v = [
    ['Gốc (đúng sách)', {}],
    ['(d) tối đa 1 lệnh mới/ngày', { maxNew: 1 }],
    ['(d) tối đa 2 lệnh mới/ngày', { maxNew: 2 }],
    ['(d) tối đa 3 lệnh mới/ngày', { maxNew: 3 }],
    ['(d) 2 lệnh/ngày + (c) BTC > SMA200', { maxNew: 2, btcFilter: true }],
    ['(d) 2 lệnh/ngày, tối đa 10 lệnh', { maxNew: 2, K: 10 }],
    ['(d)+(c), tối đa 10 lệnh', { maxNew: 2, btcFilter: true, K: 10 }],
  ];
  console.table(v.map(([l, o]) => row(l, run(o))));
} else if (process.env.MODE === 'delay') {
  console.table([0, 4, 8, 12, 24].map((d) => row(`vào/ra trễ ${d} giờ (${String((7 + d) % 24).padStart(2, '0')}:00 giờ VN)`, run({ delay: d }))));
} else {
  const v = [
    ['Gốc (đúng sách)', {}],
    ['(a) chia vốn theo biến động', { volSize: true }],
    ['(b) giữ tối đa 10 ngày', { timeStop: 10 }],
    ['(c) chỉ vào khi BTC > SMA200', { btcFilter: true }],
    ['(d) tối đa 2 lệnh mới/ngày', { maxNew: 2 }],
    ['(e) cắt lỗ thảm hoạ -20%', { stopPct: 0.2 }],
  ];
  console.table(v.map(([l, o]) => row(l, run(o))));
}
