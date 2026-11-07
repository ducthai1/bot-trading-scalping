// Logic EMA 8/13/21 của bot (gọi thẳng evaluate() trong src/strategy.js) trên khung 4h và 1d, SPOT, chỉ LONG.
//   4h: đại cục = nến ngày | 1d: đại cục = nến tuần
//   Bỏ luật SL 10–20$ (chỉ hợp BTC 3m): SL = râu nến xác nhận - 0.1 ATR(14)
//   Thoát 'md'  : 50% tại đỉnh gần nhất (TP1), dời SL về giá vào, 50% tại entry + 2×(TP1-entry)
//   Thoát 'lw'  : 50% tại 1R, 50% tại 2R, SL giữ nguyên (kiểu Lockwood gốc)
//   Spot: phí 0.1% mỗi lần khớp, trượt giá 0.02% (BTC/ETH) / 0.05% (còn lại). Mỗi coin 1/12 vốn, 1 lệnh/coin.
import { readFileSync } from 'node:fs';
import { evaluate } from '/app/src/strategy.js';
import { atr } from '/app/src/indicators.js';

const DAY = 86400e3;
const START = Date.UTC(2020, 0, 1);
const S = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const SYMS = Object.keys(S);
const FEE = 0.001;
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : 0.0005);
const MAXHOLD = 100; // bars
const cfg = { ...JSON.parse(readFileSync('/app/config.json', 'utf8')), slBuffer: 0, slMin: 0, slMax: 1e18, slWidenToMin: false, minNetRR: null };
const toC = (rows, ms) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, ct: t + ms - 1 }));
function weekly(d) {
  const out = [];
  for (const k of d) {
    const w = Math.floor((k.t - 4 * DAY) / (7 * DAY)) * 7 * DAY + 4 * DAY; // weeks start Monday 00:00 UTC
    const last = out.at(-1);
    if (!last || last.t !== w) out.push({ t: w, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, ct: w + 7 * DAY - 1 });
    else Object.assign(last, { h: Math.max(last.h, k.h), l: Math.min(last.l, k.l), c: k.c, v: last.v + k.v });
  }
  return out;
}

function backtest(sym, tf, exitMode) {
  const cs = tf === '4h' ? toC(S[sym]['4h'], 4 * 3600e3) : toC(S[sym]['1d'], DAY);
  const htf = tf === '4h' ? toC(S[sym]['1d'], DAY) : weekly(toC(S[sym]['1d'], DAY));
  const slip = SLIP(sym);
  const trades = [];
  const eq = new Map();
  let cash = 1, units = 0, pos = null, h = -1;
  for (let i = 300; i < cs.length; i++) {
    const b = cs[i];
    // manage the open position on bar i (entered at an earlier bar's close -> this bar's open)
    if (pos) {
      const sell = (frac, px) => {
        const u = pos.units0 * frac;
        cash += u * px * (1 - FEE);
        units -= u;
        pos.got += frac * (px / pos.entry) * (1 - FEE);
        pos.gotGross += frac * (px / pos.entry);
        pos.left -= frac;
      };
      if (pos.pending) {
        const entry = b.o * (1 + slip);
        if (!(entry - pos.sl > 0) || pos.tp1 <= entry) pos = null; // gap made the setup invalid: skip the order
        else {
          pos.entry = entry;
          pos.R = entry - pos.sl;
          units = (cash * (1 - FEE)) / entry;
          pos.units0 = units;
          cash = 0;
          pos.pending = false;
        }
      }
      if (pos && !pos.t1) {
        if (exitMode === 'lw') {
          pos.t1 = pos.entry + pos.R;
          pos.t2 = pos.entry + 2 * pos.R;
        } else {
          pos.t1 = pos.tp1;
          pos.t2 = pos.entry + 2 * (pos.tp1 - pos.entry);
        }
      }
      if (pos) {
        pos.bars++;
        if (b.l <= pos.stop) sell(pos.left, Math.min(pos.stop, b.o) * (1 - slip));
        else {
          if (!pos.half && b.h >= pos.t1) {
            sell(0.5, pos.t1);
            pos.half = true;
            if (exitMode === 'md') {
              pos.stop = pos.entry;
              if (b.l <= pos.stop) sell(pos.left, pos.stop * (1 - slip)); // conservative: BE hit in the same bar
            }
          }
          if (pos.left > 0 && pos.half && b.h >= pos.t2) sell(pos.left, pos.t2);
          if (pos.left > 0 && pos.bars >= MAXHOLD) sell(pos.left, b.c * (1 - slip));
        }
        if (pos.left <= 1e-9) finish();
      }
    }
    if (b.t >= START) eq.set(b.t, cash + units * b.c);
    // signal at the close of bar i -> enter at the open of bar i+1
    if (!pos && b.t >= START - 4 * DAY) {
      while (h + 1 < htf.length && htf[h + 1].ct < b.ct + 1) h++;
      if (h < 60) continue;
      const window = cs.slice(i - 299, i + 1);
      const big = htf.slice(Math.max(0, h - 299), h + 1);
      const r = evaluate({ h1: big, m15: big, candles: window, tf, cfg });
      if (r.signal && r.signal.side === 'LONG' && i + 1 < cs.length) {
        const a = atr(window, 14).at(-1);
        pos = { pending: true, sl: b.l - 0.1 * a, stop: b.l - 0.1 * a, tp1: r.signal.tp1, t: cs[i + 1].t, bars: 0, left: 1, got: 0, gotGross: 0, half: false };
      }
    }
  }
  function finish() {
    const r = (1 - FEE) * pos.got - 1; // net: entry fee + exit fees + slippage
    const gross = pos.gotGross - 1; // price move only
    trades.push({ sym, t: pos.t, r, R: (gross * pos.entry) / pos.R, feeR: pos.R ? (2 * FEE * pos.entry) / pos.R : 0, rPct: pos.R / pos.entry, year: new Date(pos.t).getUTCFullYear() });
    pos = null;
    units = 0;
  }
  return { trades, eq };
}

// ---- report ----
const allDays = [...new Set(SYMS.flatMap((s) => S[s]['1d'].map((x) => x[0])))].filter((t) => t >= START).sort((a, b) => a - b);
function portfolio(eqs) {
  const last = eqs.map(() => 1);
  let peak = 0, dd = 0, v = 1;
  const keys = [...new Set(eqs.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
  for (const t of keys) {
    v = eqs.reduce((s, m, n) => s + (m.has(t) ? (last[n] = m.get(t)) : last[n]), 0) / eqs.length;
    peak = Math.max(peak, v);
    dd = Math.max(dd, 1 - v / peak);
  }
  const years = (keys.at(-1) - keys[0]) / (365.25 * DAY);
  return { cagr: (v ** (1 / years) - 1) * 100, dd: dd * 100 };
}
const bh = SYMS.map((s) => {
  const d = S[s]['1d'].filter((x) => x[0] >= START);
  return new Map(d.map((x) => [x[0], x[4] / d[0][1]]));
});
const BH = portfolio(bh), BTC = portfolio([bh[0]]);
const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2);
console.log(`SPOT, chỉ LONG, ${SYMS.length} coin, ${new Date(allDays[0]).toISOString().slice(0, 10)} → ${new Date(allDays.at(-1)).toISOString().slice(0, 10)}`);
console.log(`Mốc so sánh: mua & giữ đều 12 coin CAGR ${f1(BH.cagr)}%/năm, sụt ${f1(BH.dd)}% | mua & giữ BTC CAGR ${f1(BTC.cagr)}%/năm, sụt ${f1(BTC.dd)}%\n`);
const rows = [], years = {}, coins = {};
for (const tf of ['4h', '1d']) {
  for (const exitMode of ['md', 'lw']) {
    const runs = SYMS.map((s) => backtest(s, tf, exitMode));
    const all = runs.flatMap((r) => r.trades).sort((a, b) => a.t - b.t);
    const P = portfolio(runs.map((r) => r.eq));
    const n = all.length;
    const w = all.filter((t) => t.r > 0), l = all.filter((t) => t.r <= 0);
    const avg = (a, f) => (a.length ? a.reduce((s, t) => s + f(t), 0) / a.length : 0);
    const gp = w.reduce((s, t) => s + t.r, 0), gl = -l.reduce((s, t) => s + t.r, 0);
    const label = `${tf} thoát kiểu ${exitMode === 'md' ? 'md (TP1=đỉnh)' : 'Lockwood (1R/2R)'}`;
    const ys = [...new Set(all.map((t) => t.year))].sort();
    years[label] = Object.fromEntries(ys.map((y) => {
      const a = all.filter((t) => t.year === y);
      return [y, `${a.length}L ${f1((a.filter((t) => t.r > 0).length / a.length) * 100)}% ${f2(avg(a, (t) => t.r) * 100)}%`];
    }));
    coins[label] = Object.fromEntries(runs.map((r, k) => [SYMS[k].replace('USDT', ''), r.trades.length ? `${r.trades.length}L ${f2(avg(r.trades, (t) => t.r) * 100)}%` : '-']));
    rows.push({
      'cấu hình': label,
      lệnh: n,
      'lệnh/năm (12 coin)': f1(n / ((allDays.at(-1) - allDays[0]) / (365.25 * DAY))),
      'thắng %': f1((w.length / n) * 100),
      'lãi TB %': f2(avg(w, (t) => t.r) * 100),
      'lỗ TB %': f2(avg(l, (t) => t.r) * 100),
      'kỳ vọng %/lệnh': f2(avg(all, (t) => t.r) * 100),
      'trước phí R': f2(avg(all, (t) => t.R)),
      'phí R': f2(avg(all, (t) => t.feeR)),
      'SL TB %': f2(avg(all, (t) => t.rPct) * 100),
      PF: f2(gl ? gp / gl : 99),
      't-stat': f2((() => { const m = avg(all, (t) => t.r), sd = Math.sqrt(avg(all, (t) => (t.r - m) ** 2)); return m / (sd / Math.sqrt(n)); })()),
      'năm dương': `${ys.filter((y) => avg(all.filter((t) => t.year === y), (t) => t.r) > 0).length}/${ys.length}`,
      'coin dương': `${runs.filter((r) => r.trades.length && avg(r.trades, (t) => t.r) > 0).length}/${SYMS.length}`,
      'CAGR % (1/12 vốn/coin)': f1(P.cagr),
      'sụt max %': f1(P.dd),
    });
  }
}
console.table(rows);
console.log('\nTheo năm (số lệnh, thắng %, kỳ vọng %/lệnh):');
console.table(years);
console.log('\nTheo coin (số lệnh, kỳ vọng %/lệnh):');
console.table(coins);
