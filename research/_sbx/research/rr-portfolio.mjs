// Danh mục "breakout + R:R cố định": mua khi giá đóng cửa vượt đỉnh 20 ngày (Turtle), SL = k×ATR, TP = RR×SL.
// Spot, tối đa 6 lệnh, mỗi lệnh 1/6 vốn, tối đa 2 lệnh mới/ngày (ưu tiên coin ít biến động hơn).
// Khớp SL/TP trên nến 4h (cùng nến -> SL trước). Kiểm chứng: coin cũ/mới × 2020–22 / 2023–26.
import { readFileSync } from 'node:fs';

const DAY = 86400e3, H4 = 4 * 3600e3;
const START = Date.UTC(2020, 0, 1), MID = Date.UTC(2023, 0, 1);
const A = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const B = JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8'));
const OLD = Object.keys(A), DATA = { ...A, ...B }, SYMS = Object.keys(DATA);
const FEE = 0.001;
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : OLD.includes(s) ? 0.0005 : 0.0008);
function rma(v, p) { const o = new Array(v.length).fill(NaN); let x; for (let i = 0; i < v.length; i++) { if (i === p - 1) x = v.slice(0, p).reduce((a, b) => a + b, 0) / p; else if (i >= p) x = (x * (p - 1) + v[i]) / p; o[i] = x; } return o; }
const toC = (rows, ms) => rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c, ct: t + ms - 1 }));

const X = {};
for (const s of SYMS) {
  const d = toC(DATA[s]['1d'], DAY), h4 = toC(DATA[s]['4h'], H4);
  const atr = rma(d.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - d[i - 1].c), Math.abs(x.l - d[i - 1].c)) : x.h - x.l)), 14);
  const sig = new Map(); // entry day -> atr at signal
  for (let i = 30; i < d.length - 1; i++) if (d[i].c > Math.max(...d.slice(i - 20, i).map((x) => x.h))) sig.set(d[i + 1].t, { atr: atr[i], atrPct: atr[i] / d[i].c });
  const h4ByDay = new Map();
  for (const x of h4) { const day = Math.floor(x.t / DAY) * DAY; if (!h4ByDay.has(day)) h4ByDay.set(day, []); h4ByDay.get(day).push(x); }
  X[s] = { d, idx: new Map(d.map((x, i) => [x.t, i])), sig, h4ByDay };
}
const days = [...new Set(SYMS.flatMap((s) => X[s].d.map((x) => x.t)))].filter((t) => t >= START).sort((a, b) => a - b);

const BTC = X.BTCUSDT, btcS200 = (() => { const c = BTC.d.map((x) => x.c); return c.map((_, i) => (i < 199 ? NaN : c.slice(i - 199, i + 1).reduce((a, b) => a + b, 0) / 200)); })();
function run({ k, rr, K = 6, maxNew = 2, btcFilter = false }) {
  let cash = 1, peak = 1, dd = 0, eqPrev = 1;
  const pos = new Map(), log = [], yearEq = {}, curve = [];
  const close = (sym, px, t, hit) => { const p = pos.get(sym); cash += p.q * px * (1 - FEE); log.push({ old: OLD.includes(sym), t: p.t, R: ((px * (1 - FEE)) / (p.e * (1 + FEE)) - 1) * (p.e / p.dist), ret: (px * (1 - FEE)) / (p.e * (1 + FEE)) - 1, hit }); pos.delete(sym); };
  for (const t of days) {
    // new entries at today's open (signals from yesterday's close)
    const bi = BTC.idx.get(t - DAY);
    const btcOk = !btcFilter || (bi != null && BTC.d[bi].c > btcS200[bi]);
    const cands = SYMS.filter((s) => btcOk && X[s].sig.has(t) && !pos.has(s) && X[s].h4ByDay.has(t)).sort((a, b) => X[a].sig.get(t).atrPct - X[b].sig.get(t).atrPct);
    let opened = 0;
    for (const s of cands) {
      if (pos.size >= K || opened >= maxNew) break;
      const { atr } = X[s].sig.get(t), e = X[s].h4ByDay.get(t)[0].o * (1 + SLIP(s)), dist = k * atr;
      if (!(e - dist > 0)) continue;
      const alloc = Math.min(eqPrev / K, cash / (1 + FEE));
      pos.set(s, { q: alloc / e, e, dist, sl: e - dist, tp: e + rr * dist, t, days: 0 });
      cash -= alloc * (1 + FEE);
      opened++;
    }
    // walk today's 4h candles for every open position
    for (const [s, p] of [...pos]) {
      const bars = X[s].h4ByDay.get(t) || [];
      for (const b of bars) {
        if (b.l <= p.sl) { close(s, Math.min(p.sl, b.t > p.t ? b.o : p.sl) * (1 - SLIP(s)), t, false); break; }
        if (b.h >= p.tp) { close(s, p.tp, t, true); break; }
      }
      if (pos.has(s) && ++p.days >= 60) { const i = X[s].idx.get(t); close(s, X[s].d[i].c * (1 - SLIP(s)), t, null); }
    }
    const eq = cash + [...pos].reduce((a, [s, p]) => { const i = X[s].idx.get(t); return a + p.q * (i != null ? X[s].d[i].c : p.e); }, 0);
    peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); eqPrev = eq;
    yearEq[new Date(t).getUTCFullYear()] = eq;
    curve.push([t, eq]);
  }
  const yrs = (days.at(-1) - days[0]) / (365.25 * DAY);
  let prev = 1;
  const yearly = Object.values(yearEq).map((e) => { const r = (e / prev - 1) * 100; prev = e; return r; });
  const avg = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
  const cell = (o, early) => avg(log.filter((x) => x.old === o && (early ? x.t < MID : x.t >= MID)), (x) => x.R);
  return { curve, n: log.length, perWeek: log.length / yrs / 52, hit: log.filter((x) => x.hit).length / log.length * 100, win: log.filter((x) => x.ret > 0).length / log.length * 100, R: avg(log, (x) => x.R), cagr: (eqPrev ** (1 / yrs) - 1) * 100, dd: dd * 100, yearly, cells: [cell(true, true), cell(true, false), cell(false, true), cell(false, false)] };
}

const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
if (process.env.CURVE) { process.stdout.write(JSON.stringify(run({ k: 2, rr: 3, btcFilter: process.env.CURVE === "btc" }).curve), () => process.exit(0)); } else {
const rows = [];
for (const [k, rr, bf] of [[2, 3, false], [2, 3, true], [1.5, 2, false], [1.5, 2, true]]) {
  const r = run({ k, rr, btcFilter: bf });
  rows.push({ 'SL × ATR': k, 'R:R': `1:${rr}`, 'lọc BTC': bf ? 'có' : 'không', 'lệnh/tuần': f1(r.perWeek), 'chạm TP %': f1(r.hit), 'mức đồng xu %': f1(100 / (1 + rr)), 'R ròng/lệnh': f2(r.R), '%/năm': f1(r.cagr), 'sụt max %': f1(r.dd), 'từng năm %': r.yearly.map((x) => x.toFixed(0)).join(' '), '4 ô (R)': r.cells.map(f2).join(' / '), 'cả 4 dương': r.cells.every((x) => x > 0) ? '✅' : '❌' });
}
console.table(rows);
}
