// Backtest khung NGÀY cho các chiến lược kinh điển, đúng tham số trong sách (không tối ưu).
// Futures 1x, phí taker 0.05%/chiều (maker 0.02% cho lệnh chốt lời), trượt giá, funding thật.
import { readFileSync } from 'node:fs';

const DAY = 86400e3;
const D = JSON.parse(readFileSync('/app/_sbx/data/2y/daily.json', 'utf8'));
const START = Date.UTC(2020, 0, 1);
const COST = { taker: 0.0005, maker: 0.0002 };
const RSI_TH = Number(process.env.RSI_TH || 5);
const ONLY = process.env.ONLY ? process.env.ONLY.split('|') : null;
const SIDES = process.env.SIDES === 'long' ? [1] : [1, -1];
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : 0.0005);

// ---------- indicators ----------
const sma = (v, p) => v.map((_, i) => (i < p - 1 ? NaN : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p));
function ema(v, p) {
  const o = new Array(v.length).fill(NaN);
  if (v.length < p) return o;
  let x = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  o[p - 1] = x;
  for (let i = p; i < v.length; i++) o[i] = x = v[i] * (2 / (p + 1)) + x * (1 - 2 / (p + 1));
  return o;
}
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
const trueRange = (k) => k.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - k[i - 1].c), Math.abs(x.l - k[i - 1].c)) : x.h - x.l));
function dmi(k, p) {
  const pd = [0], md = [0];
  for (let i = 1; i < k.length; i++) {
    const up = k[i].h - k[i - 1].h, dn = k[i - 1].l - k[i].l;
    pd.push(up > dn && up > 0 ? up : 0);
    md.push(dn > up && dn > 0 ? dn : 0);
  }
  const tr = rma(trueRange(k), p), sp = rma(pd, p), sm = rma(md, p);
  const pdi = sp.map((x, i) => (100 * x) / tr[i]), mdi = sm.map((x, i) => (100 * x) / tr[i]);
  const dx = pdi.map((x, i) => (x + mdi[i] ? (100 * Math.abs(x - mdi[i])) / (x + mdi[i]) : 0)).map((x) => (Number.isNaN(x) ? 0 : x));
  return { adx: rma(dx, p), pdi, mdi };
}
const hh = (k, i, n) => Math.max(...k.slice(i - n + 1, i + 1).map((x) => x.h)); // highest high of bars i-n+1..i
const ll = (k, i, n) => Math.min(...k.slice(i - n + 1, i + 1).map((x) => x.l));

// ---------- strategies: decide at close of bar i what to do on bar i+1 ----------
// entry(i) -> { type:'open'|'stop', price?, stop?, target? } ; exit(i, tr) -> { atOpen?, stop?, target? }
const STRATS = {
  'RSI(2) Connors': (k, side) => {
    const c = k.map((x) => x.c), s200 = sma(c, 200), s5 = sma(c, 5), r = rsi(c, 2);
    return {
      entry: (i) => (side * (c[i] - s200[i]) > 0 && (side > 0 ? r[i] < RSI_TH : r[i] > 100 - RSI_TH) ? { type: 'open' } : null),
      exit: (i) => ({ atOpen: side * (c[i] - s5[i]) > 0 }),
    };
  },
  'Double 7s Connors': (k, side) => {
    const c = k.map((x) => x.c), s200 = sma(c, 200);
    const ext = (i, f) => f(...c.slice(i - 6, i + 1));
    return {
      entry: (i) => (side * (c[i] - s200[i]) > 0 && c[i] === ext(i, side > 0 ? Math.min : Math.max) ? { type: 'open' } : null),
      exit: (i) => ({ atOpen: c[i] === ext(i, side > 0 ? Math.max : Math.min) }),
    };
  },
  'Turtle S2 (55/20)': (k, side) => turtle(k, side, 55, 20),
  'Turtle S1 (20/10)': (k, side) => turtle(k, side, 20, 10),
  'Holy Grail Raschke': (k, side) => {
    const c = k.map((x) => x.c), e20 = ema(c, 20), { adx, pdi, mdi } = dmi(k, 14);
    return {
      entry: (i) => {
        if (!(adx[i] > 30 && adx[i] > adx[i - 5] && side * (pdi[i] - mdi[i]) > 0)) return null;
        if (!(side > 0 ? k[i].l <= e20[i] : k[i].h >= e20[i])) return null;
        const price = side > 0 ? k[i].h : k[i].l;
        const target = side > 0 ? hh(k, i - 1, 20) : ll(k, i - 1, 20);
        if (side * (target - price) <= 0) return null;
        return { type: 'stop', price, stop: side > 0 ? k[i].l : k[i].h, target };
      },
      exit: (i, tr) => ({ stop: tr.stop, target: tr.target }),
    };
  },
  'Volatility Breakout L.Williams (k=0.5)': (k, side) => ({
    // stop order placed at the open of bar i+1: open +/- 0.5 x range of bar i
    entry: (i) => ({ type: 'stop', price: k[i + 1] ? k[i + 1].o + side * 0.5 * (k[i].h - k[i].l) : NaN, dayTrade: true }),
    exit: () => ({ atOpen: true }),
  }),
};

function turtle(k, side, nIn, nOut) {
  const N = rma(trueRange(k), 20);
  return {
    entry: (i) => ({ type: 'stop', price: side > 0 ? hh(k, i, nIn) : ll(k, i, nIn), stopN: 2 * N[i] }),
    exit: (i, tr) => {
      const don = side > 0 ? ll(k, i, nOut) : hh(k, i, nOut);
      return { stop: side > 0 ? Math.max(tr.stop, don) : Math.min(tr.stop, don) };
    },
  };
}

// ---------- engine ----------
function simulate(sym, name, side) {
  const k = D[sym].k.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const fund = D[sym].f;
  const slip = SLIP(sym);
  const st = STRATS[name](k, side);
  const fundingBetween = (a, b) => fund.reduce((s, [t, r]) => (t > a && t <= b ? s + r : s), 0);
  const trades = [];
  const eq = new Map(); // day -> sleeve equity (start 1)
  let E = 1, pos = null;
  const W = 210; // warm-up (SMA200 etc.)
  for (let j = W; j < k.length; j++) {
    const b = k[j], i = j - 1;
    // 1) manage open position on bar j
    if (pos) {
      const x = st.exit(i, pos);
      let px = null, fee = COST.taker, why;
      if (x.atOpen) {
        px = b.o;
        why = 'open';
      } else {
        const stopHit = x.stop != null && (side > 0 ? b.l <= x.stop : b.h >= x.stop);
        const tgtHit = x.target != null && (side > 0 ? b.h >= x.target : b.l <= x.target);
        if (stopHit) {
          px = side > 0 ? Math.min(x.stop, b.o) : Math.max(x.stop, b.o);
          why = 'stop';
        } else if (tgtHit) {
          px = side > 0 ? Math.max(x.target, b.o) : Math.min(x.target, b.o);
          fee = COST.maker;
          why = 'target';
        }
      }
      if (px != null) closePos(px * (1 - side * (why === 'target' ? 0 : slip)), fee, why === 'open' ? b.t : b.t + DAY / 2);
    }
    // 2) new entry on bar j (decided at close of bar i)
    if (!pos) {
      const e = st.entry(i);
      if (e && !Number.isNaN(e.price ?? 0)) {
        let px = null;
        if (e.type === 'open') px = b.o;
        else if (side > 0 ? b.h >= e.price : b.l <= e.price) px = side > 0 ? Math.max(e.price, b.o) : Math.min(e.price, b.o);
        if (px != null && b.t >= START) {
          const entry = px * (1 + side * slip);
          pos = { entry, t: e.type === 'open' ? b.t : b.t + DAY / 2, E0: E, j, stop: e.stop ?? (e.stopN != null ? entry - side * e.stopN : null), target: e.target ?? null };
          // same-bar protective stop (conservative: assume it was hit after the fill)
          if (e.type === 'stop' && pos.stop != null && (side > 0 ? b.l <= pos.stop : b.h >= pos.stop)) {
            closePos(pos.stop * (1 - side * slip), COST.taker, b.t + DAY);
          }
        }
      }
    }
    // 3) mark to market at the close of bar j
    if (b.t >= START) eq.set(b.t, pos ? pos.E0 * (1 + side * (b.c / pos.entry - 1) - COST.taker) : E);
  }
  function closePos(px, feeOut, tExit) {
    const fr = fundingBetween(pos.t, tExit);
    const r = side * (px / pos.entry - 1) - COST.taker - feeOut - side * fr;
    trades.push({ sym, px: pos.entry, exitPx: px, t: pos.t, r, days: Math.max(1, Math.round((tExit - pos.t) / DAY)), year: new Date(pos.t).getUTCFullYear(), funding: -side * fr });
    E = pos.E0 * (1 + r);
    pos = null;
  }
  return { trades, eq };
}

// ---------- reporting ----------
const SYMS = Object.keys(D);
const days = [...new Set(SYMS.flatMap((s) => D[s].k.map((x) => x[0])))].filter((t) => t >= START).sort((a, b) => a - b);
function portfolio(eqs) {
  // equal-weight sleeves; a sleeve sits in cash (=1) until its coin has data
  const last = eqs.map(() => 1);
  let peak = 0, dd = 0, v = 0;
  for (const t of days) {
    v = eqs.reduce((s, m, n) => s + (m.has(t) ? (last[n] = m.get(t)) : last[n]), 0) / eqs.length;
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
  }
  const years = (days.at(-1) - days[0]) / (365.25 * DAY);
  return { cagr: (v ** (1 / years) - 1) * 100, dd: dd * 100, total: (v - 1) * 100 };
}
function summarize(trades) {
  const n = trades.length;
  if (!n) return null;
  const w = trades.filter((t) => t.r > 0), l = trades.filter((t) => t.r <= 0);
  const avg = (a, f = (t) => t.r) => (a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : 0);
  const gp = w.reduce((s, t) => s + t.r, 0), gl = -l.reduce((s, t) => s + t.r, 0);
  return { n, win: (w.length / n) * 100, avgWin: avg(w) * 100, avgLoss: avg(l) * 100, exp: avg(trades) * 100, pf: gl ? gp / gl : 99, hold: avg(trades, (t) => t.days), funding: avg(trades, (t) => t.funding) * 100 };
}
const f1 = (x) => (x == null ? '-' : x.toFixed(1));
const f2 = (x) => (x == null ? '-' : x.toFixed(2));

// Benchmark: equal-weight buy & hold, and BTC buy & hold
const bh = SYMS.map((s) => {
  const k = D[s].k.filter((x) => x[0] >= START);
  return new Map(k.map((x) => [x[0], x[4] / k[0][1]]));
});
const BH = portfolio(bh), BTC = portfolio([bh[0]]);
console.log(`Giai đoạn ${new Date(days[0]).toISOString().slice(0, 10)} → ${new Date(days.at(-1)).toISOString().slice(0, 10)}, ${SYMS.length} coin: ${SYMS.map((s) => s.replace('USDT', '')).join(', ')}`);
console.log(`Mốc so sánh — Mua & giữ đều 12 coin: CAGR ${f1(BH.cagr)}%/năm, sụt tối đa ${f1(BH.dd)}% | Mua & giữ BTC: CAGR ${f1(BTC.cagr)}%/năm, sụt tối đa ${f1(BTC.dd)}%\n`);

const rows = [], yearly = {}, perCoin = {};
for (const name of Object.keys(STRATS).filter((n) => !ONLY || ONLY.includes(n))) {
  for (const side of SIDES) {
    const runs = SYMS.map((s) => ({ s, ...simulate(s, name, side) }));
    const all = runs.flatMap((r) => r.trades);
    const S = summarize(all);
    const P = portfolio(runs.map((r) => r.eq));
    const label = `${name} ${side > 0 ? 'LONG' : 'SHORT'}`;
    if (process.env.DUMP) {
      const fmt = (t) => `${new Date(t.t).toISOString().slice(0, 10)} ${t.sym.padEnd(9)} vào ${t.px.toPrecision(6)} ra ${t.exitPx.toPrecision(6)} giữ ${t.days}d  ${(t.r * 100).toFixed(1)}%`;
      console.log(`-- ${label}: 6 lệnh tệ nhất`);
      [...all].sort((x, y) => x.r - y.r).slice(0, 6).forEach((t) => console.log('  ' + fmt(t)));
      console.log(`-- ${label}: 4 lệnh BTC gần nhất`);
      all.filter((t) => t.sym === 'BTCUSDT').slice(-4).forEach((t) => console.log('  ' + fmt(t)));
    }
    if (!S) continue;
    const years = [...new Set(all.map((t) => t.year))].sort();
    const ys = years.map((y) => summarize(all.filter((t) => t.year === y)));
    yearly[label] = Object.fromEntries(years.map((y, n) => [y, `${f1(ys[n].win)}% / ${f2(ys[n].exp)}%`]));
    perCoin[label] = Object.fromEntries(runs.map((r) => [r.s.replace('USDT', ''), r.trades.length ? f2(summarize(r.trades).exp) : '-']));
    rows.push({
      'chiến lược': label,
      lệnh: S.n,
      'lệnh/coin/năm': f1(S.n / SYMS.length / 6.85),
      'thắng %': f1(S.win),
      'lãi TB %': f2(S.avgWin),
      'lỗ TB %': f2(S.avgLoss),
      'kỳ vọng %/lệnh': f2(S.exp),
      PF: f2(S.pf),
      't-stat': f2((() => { const m = all.reduce((x, t) => x + t.r, 0) / all.length, sd = Math.sqrt(all.reduce((x, t) => x + (t.r - m) ** 2, 0) / all.length); return m / (sd / Math.sqrt(all.length)); })()),
      'giữ (ngày)': f1(S.hold),
      'funding %/lệnh': f2(S.funding),
      'lệnh tệ nhất %': f1(Math.min(...all.map((t) => t.r)) * 100),
      'thua liên tiếp max': (() => { let m = 0, c = 0; for (const t of all.sort((a, b) => a.t - b.t)) { c = t.r <= 0 ? c + 1 : 0; m = Math.max(m, c); } return m; })(),
      'thời gian cầm lệnh %': f1((all.reduce((s, t) => s + t.days, 0) / (SYMS.length * 6.85 * 365)) * 100),
      'năm dương': `${ys.filter((y) => y.exp > 0).length}/${ys.length}`,
      'CAGR % (danh mục)': f1(P.cagr),
      'sụt max %': f1(P.dd),
    });
  }
}
console.table(rows);
console.log('\nTheo năm (thắng% / kỳ vọng % mỗi lệnh):');
console.table(yearly);
console.log('\nTheo coin (kỳ vọng % mỗi lệnh):');
console.table(perCoin);
