// Họ chiến lược ngắn hạn của Connors & Alvarez (High Probability ETF Trading; Short Term Trading
// Strategies That Work) — đúng luật trong sách, SPOT, chỉ LONG, giữ lệnh vài ngày.
// Vào lệnh lúc mở cửa phiên sau tín hiệu (≈ giá đóng cửa của Connors); thoát lúc mở cửa phiên sau tín hiệu thoát.
// Phí spot 0.1%/chiều; trượt giá 0.02% BTC/ETH, 0.05% 10 coin cũ khác, 0.08% coin mới (thanh khoản thấp hơn).
// Kiểm chứng độc lập: 12 coin cũ (đã dùng ở các phép thử trước) vs coin mới (chưa từng thấy); 2020–22 vs 2023–26.
// TIÊU CHÍ ĐẠT (chốt trước): kỳ vọng > 0 ở cả 4 ô và t-stat tổng > 2.5.
import { readFileSync, existsSync } from 'node:fs';

const DAY = 86400e3;
const START = Date.UTC(2020, 0, 1), MID = Date.UTC(2023, 0, 1);
const A = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const B = existsSync('/app/_sbx/data/2y/spot2.json') ? JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8')) : {};
const OLD = Object.keys(A), NEW = Object.keys(B).filter((s) => B[s]['1d'].length > 500);
const DATA = { ...A, ...B };
const SYMS = [...OLD, ...NEW];
const FEE = 0.001;
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : OLD.includes(s) ? 0.0005 : 0.0008);

const sma = (v, p) => {
  const o = new Array(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= p) s -= v[i - p];
    if (i >= p - 1) o[i] = s / p;
  }
  return o;
};
function rma(v, p) {
  const o = new Array(v.length).fill(NaN);
  let x;
  for (let i = 0; i < v.length; i++) {
    if (i === p - 1) x = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
    else if (i >= p) x = (x * (p - 1) + v[i]) / p;
    o[i] = x;
  }
  return o;
}
function rsi(c, p) {
  const g = [0], l = [0];
  for (let i = 1; i < c.length; i++) {
    g.push(Math.max(c[i] - c[i - 1], 0));
    l.push(Math.max(c[i - 1] - c[i], 0));
  }
  const ag = rma(g, p), al = rma(l, p);
  return c.map((_, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i])));
}
function pctB(c, p, k) {
  const m = sma(c, p);
  return c.map((x, i) => {
    if (i < p - 1) return NaN;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (c[j] - m[i]) ** 2;
    const sd = Math.sqrt(s / p);
    return sd ? (x - (m[i] - k * sd)) / (2 * k * sd) : 0.5;
  });
}

const cache = {};
function series(sym, tf) {
  const key = sym + tf;
  if (cache[key]) return cache[key];
  const k = DATA[sym][tf].map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const c = k.map((x) => x.c);
  return (cache[key] = { k, c, h: k.map((x) => x.h), l: k.map((x) => x.l), s200: sma(c, 200), s5: sma(c, 5), r2: rsi(c, 2), r4: rsi(c, 4), pb: pctB(c, 5, 1) });
}

const up = (S, i) => S.c[i] > S.s200[i];
const STRATS = {
  'RSI(2)<5 [STTSTW]': { entry: (S, i) => up(S, i) && S.r2[i] < 5, exit: (S, i) => S.c[i] > S.s5[i] },
  'RSI 10/6: RSI(2)<10 [HPETF]': { entry: (S, i) => up(S, i) && S.r2[i] < 10, exit: (S, i) => S.c[i] > S.s5[i] },
  'R3 [HPETF]': {
    entry: (S, i) => up(S, i) && S.r2[i] < S.r2[i - 1] && S.r2[i - 1] < S.r2[i - 2] && S.r2[i - 2] < S.r2[i - 3] && S.r2[i - 3] < 60 && S.r2[i] < 10,
    exit: (S, i) => S.r2[i] > 70,
  },
  'RSI 25/75: RSI(4)<25 [HPETF]': { entry: (S, i) => up(S, i) && S.r4[i] < 25, exit: (S, i) => S.r4[i] > 55 },
  '%b <0.2 x3 ngày [HPETF]': { entry: (S, i) => up(S, i) && S.pb[i] < 0.2 && S.pb[i - 1] < 0.2 && S.pb[i - 2] < 0.2, exit: (S, i) => S.pb[i] > 0.8 },
  'MDD 4/5 ngày giảm [HPETF]': {
    entry: (S, i) => up(S, i) && S.c[i] < S.s5[i] && [0, 1, 2, 3, 4].filter((d) => S.c[i - d] < S.c[i - d - 1]).length >= 4,
    exit: (S, i) => S.c[i] > S.s5[i],
  },
  '3-Day High/Low [HPETF]': {
    entry: (S, i) => up(S, i) && S.c[i] < S.s5[i] && S.h[i] < S.h[i - 1] && S.h[i - 1] < S.h[i - 2] && S.h[i - 2] < S.h[i - 3] && S.l[i] < S.l[i - 1] && S.l[i - 1] < S.l[i - 2] && S.l[i - 2] < S.l[i - 3],
    exit: (S, i) => S.c[i] > S.s5[i],
  },
  'Double 7s [STTSTW]': {
    entry: (S, i) => up(S, i) && S.c[i] <= Math.min(...S.c.slice(i - 6, i + 1)),
    exit: (S, i) => S.c[i] >= Math.max(...S.c.slice(i - 6, i + 1)),
  },
  '4h RSI(2)<10 (mở rộng, không có trong sách)': { tf: '4h', entry: (S, i) => up(S, i) && S.r2[i] < 10, exit: (S, i) => S.c[i] > S.s5[i] },
};

// Per-coin independent trades (for per-trade statistics).
function trades(name, sym) {
  const st = STRATS[name], tf = st.tf || '1d', S = series(sym, tf), slip = SLIP(sym), out = [];
  let pos = null, enter = false, leave = false;
  for (let j = 211; j < S.k.length; j++) {
    const b = S.k[j];
    if (pos && leave) {
      const px = b.o * (1 - slip);
      out.push({ sym, old: OLD.includes(sym), t: pos.t, ret: (px * (1 - FEE)) / (pos.px * (1 + FEE)) - 1, bars: j - pos.j });
      pos = null;
    }
    if (!pos && enter && b.t >= START) pos = { px: b.o * (1 + slip), t: b.t, j };
    enter = leave = false;
    if (pos) leave = st.exit(S, j);
    else enter = st.entry(S, j);
  }
  return out;
}

function stat(T) {
  const n = T.length;
  if (!n) return { n: 0 };
  const m = T.reduce((s, t) => s + t.ret, 0) / n;
  const sd = Math.sqrt(T.reduce((s, t) => s + (t.ret - m) ** 2, 0) / n);
  const w = T.filter((t) => t.ret > 0), l = T.filter((t) => t.ret <= 0);
  const gp = w.reduce((s, t) => s + t.ret, 0), gl = -l.reduce((s, t) => s + t.ret, 0);
  return { n, win: (w.length / n) * 100, aw: w.length ? (gp / w.length) * 100 : 0, al: l.length ? (-gl / l.length) * 100 : 0, exp: m * 100, pf: gl ? gp / gl : 99, t: m / (sd / Math.sqrt(n)), worst: Math.min(...T.map((t) => t.ret)) * 100 };
}

// Shared-capital portfolio: K slots of 1/K equity, priority = lowest RSI(2); orders < 5$ are skipped (spot minimum).
function portfolio(names, K, capital) {
  if (!Array.isArray(names)) names = [names];
  const st = STRATS[names[0]], tf = st.tf || '1d';
  const log = [], yearEq = {};
  const S = Object.fromEntries(SYMS.map((s) => [s, series(s, tf)]));
  const idx = Object.fromEntries(SYMS.map((s) => [s, new Map(S[s].k.map((x, i) => [x.t, i]))]));
  const times = [...new Set(SYMS.flatMap((s) => S[s].k.map((x) => x.t)))].filter((t) => t >= START).sort((a, b) => a - b);
  let cash = capital, eqPrev = capital, peak = capital, dd = 0, n = 0, skipped = 0, signals = 0;
  const pos = new Map(), wantIn = [], wantOut = new Set();
  const val = (t) => cash + [...pos].reduce((s, [sym, p]) => { const i = idx[sym].get(t); return s + p.q * (i != null ? S[sym].c[i] : p.px); }, 0);
  for (const t of times) {
    for (const sym of wantOut) {
      const i = idx[sym].get(t);
      if (i == null || !pos.has(sym)) continue;
      const p = pos.get(sym), px = S[sym].k[i].o * (1 - SLIP(sym));
      cash += p.q * px * (1 - FEE);
      log.push({ sym, strat: p.strat, t: p.t, days: Math.round((t - p.t) / DAY), ret: (px * (1 - FEE)) / (p.px * (1 + FEE)) - 1, usd: p.q * px * (1 - FEE) - p.cost });
      pos.delete(sym);
      n++;
    }
    wantOut.clear();
    for (const { sym, strat } of wantIn.sort((a, b) => a.r - b.r)) {
      const i = idx[sym].get(t);
      if (i == null || pos.has(sym)) continue;
      signals++;
      const alloc = Math.min(eqPrev / K, cash / (1 + FEE));
      if (pos.size >= K || alloc < 5) { skipped++; continue; }
      const px = S[sym].k[i].o * (1 + SLIP(sym));
      pos.set(sym, { q: alloc / px, px, strat, t, cost: alloc * (1 + FEE) });
      cash -= alloc * (1 + FEE);
    }
    wantIn.length = 0;
    const eq = val(t);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
    eqPrev = eq;
    yearEq[new Date(t).getUTCFullYear()] = eq;
    for (const sym of SYMS) {
      const i = idx[sym].get(t);
      if (i == null || i < 211) continue;
      if (pos.has(sym)) { if (STRATS[pos.get(sym).strat].exit(S[sym], i)) wantOut.add(sym); }
      else {
        const hit = names.find((nm) => STRATS[nm].entry(S[sym], i));
        if (hit) wantIn.push({ sym, r: S[sym].r2[i], strat: hit });
      }
    }
  }
  const years = (times.at(-1) - times[0]) / (365.25 * DAY);
  let prev = capital;
  const yearly = Object.fromEntries(Object.entries(yearEq).map(([y, e]) => { const r = ((e / prev - 1) * 100).toFixed(1) + '%'; prev = e; return [y, r]; }));
  return { cagr: ((val(times.at(-1)) / capital) ** (1 / years) - 1) * 100, dd: dd * 100, perYear: n / years, missed: signals ? (skipped / signals) * 100 : 0, log, yearly, final: val(times.at(-1)) };
}

if (process.env.MODE) {
  const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
  if (process.env.MODE === 'check') {
    for (const t of trades('R3 [HPETF]', 'BTCUSDT').filter((x) => new Date(x.t).getUTCFullYear() === 2024)) console.log(`JS R3 BTC: mua ${new Date(t.t).toISOString().slice(0, 10)} ${(t.ret * 100).toFixed(2)}% giữ ${t.bars} ngày`);
  } else {
    const COMBO = ['R3 [HPETF]', 'RSI 25/75: RSI(4)<25 [HPETF]', 'RSI(2)<5 [STTSTW]', 'MDD 4/5 ngày giảm [HPETF]'];
    const sets = [['Chỉ R3', ['R3 [HPETF]']], ['Ghép 4 chiến lược đạt', COMBO]];
    for (const K of [10, 6]) for (const [label, names] of sets) {
      const P = portfolio(names, K, 100000);
      const L = P.log, w = L.filter((x) => x.ret > 0), l = L.filter((x) => x.ret <= 0);
      const avg = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
      let need = null;
      for (const c of [20, 30, 40, 50, 60, 70, 80, 100, 150, 200]) if (portfolio(names, K, c).missed <= P.missed + 1) { need = c; break; }
      console.log(JSON.stringify({ 'danh mục': label, 'tối đa lệnh': K, 'lệnh/tuần': f1(P.perYear / 52), 'giữ TB (ngày)': f1(avg(L, (x) => x.days)), 'thắng %': f1((w.length / L.length) * 100), 'lãi TB %': f2(avg(w, (x) => x.ret) * 100), 'lỗ TB %': f2(avg(l, (x) => x.ret) * 100), 'kỳ vọng %': f2(avg(L, (x) => x.ret) * 100), 'tệ nhất %': f1(Math.min(...L.map((x) => x.ret)) * 100), 'lợi nhuận %/năm': f1(P.cagr), 'sụt vốn max %': f1(P.dd), 'vốn tối thiểu $': need, 'từng năm': P.yearly, 'theo chiến lược': Object.fromEntries(names.map((nm) => [nm.split(' ')[0], L.filter((x) => x.strat === nm).length])) }));
    }
  }
  process.exit(0);
}
const f1 = (x) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(1)), f2 = (x) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(2));
console.log(`Coin cũ (${OLD.length}): ${OLD.map((s) => s.replace('USDT', '')).join(' ')}`);
console.log(`Coin mới (${NEW.length}): ${NEW.map((s) => s.replace('USDT', '')).join(' ')}\n`);
const main = [], cells = [], port = [];
for (const name of Object.keys(STRATS)) {
  const T = SYMS.flatMap((s) => trades(name, s));
  const s = stat(T);
  const cell = (o, early) => stat(T.filter((t) => t.old === o && (early ? t.t < MID : t.t >= MID)));
  const c4 = [cell(true, true), cell(true, false), cell(false, true), cell(false, false)];
  const pass = c4.every((c) => c.n && c.exp > 0) && s.t > 2.5;
  const years = (Date.now() - START) / (365.25 * DAY);
  main.push({ 'chiến lược': name, lệnh: s.n, [`lệnh/tuần (${SYMS.length} coin)`]: f1(s.n / years / 52), 'thắng %': f1(s.win), 'lãi TB %': f2(s.aw), 'lỗ TB %': f2(s.al), 'kỳ vọng %': f2(s.exp), PF: f2(s.pf), 't-stat': f2(s.t), 'tệ nhất %': f1(s.worst), 'ĐẠT?': pass ? '✅' : '❌' });
  cells.push({ 'chiến lược': name, 'cũ 20-22': `${f2(c4[0].exp)} (${c4[0].n})`, 'cũ 23-26': `${f2(c4[1].exp)} (${c4[1].n})`, 'MỚI 20-22': `${f2(c4[2].exp)} (${c4[2].n})`, 'MỚI 23-26': `${f2(c4[3].exp)} (${c4[3].n})` });
  const P = portfolio(name, 10, 100000);
  port.push({ 'chiến lược': name, 'lệnh/tuần': f1(P.perYear / 52), 'lợi nhuận %/năm': f1(P.cagr), 'sụt vốn max %': f1(P.dd), 'bỏ lỡ vì đủ 10 lệnh %': f1(P.missed) });
}
console.log('[1] Từng lệnh, tất cả coin (kỳ vọng = lãi/lỗ trung bình mỗi lệnh sau phí):');
console.table(main);
console.log('\n[2] Kiểm chứng độc lập — kỳ vọng %/lệnh (số lệnh) theo nhóm coin và giai đoạn:');
console.table(cells);
console.log('\n[3] Danh mục: tối đa 10 lệnh cùng lúc, mỗi lệnh 1/10 vốn, spot:');
console.table(port);
