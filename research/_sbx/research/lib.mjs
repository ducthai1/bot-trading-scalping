// Engine nghiên cứu: gộp khung, chỉ báo, khớp lệnh trên nến 5m (phí + trượt giá), thống kê.
import { readFileSync } from 'node:fs';

export const MIN = 60e3;

export function load(sym) {
  const d = JSON.parse(readFileSync(`/app/_sbx/data/2y/${sym}_5m.json`, 'utf8'));
  return d.rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
}

// OHLCV aggregation aligned to UTC multiples of `minutes`.
export function aggregate(m5, minutes) {
  const P = minutes * MIN;
  const out = [];
  let cur = null;
  for (const k of m5) {
    const g = Math.floor(k.t / P) * P;
    if (!cur || cur.t !== g) {
      cur = { t: g, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, ct: g + P - 1 };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    }
  }
  return out;
}

export function ema(vals, p) {
  const out = new Array(vals.length).fill(NaN);
  if (vals.length < p) return out;
  let prev = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  const k = 2 / (p + 1);
  for (let i = p; i < vals.length; i++) out[i] = prev = vals[i] * k + prev * (1 - k);
  return out;
}

export function sma(vals, p) {
  const out = new Array(vals.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= p) s -= vals[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

export function stdev(vals, p) {
  const m = sma(vals, p);
  const out = new Array(vals.length).fill(NaN);
  for (let i = p - 1; i < vals.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (vals[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / p);
  }
  return out;
}

function rma(vals, p) {
  const out = new Array(vals.length).fill(NaN);
  let prev = NaN;
  for (let i = 0; i < vals.length; i++) {
    if (i === p - 1) prev = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
    else if (i >= p) prev = (prev * (p - 1) + vals[i]) / p;
    out[i] = prev;
  }
  return out;
}

export function atr(cs, p = 14) {
  const tr = cs.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - cs[i - 1].c), Math.abs(k.l - cs[i - 1].c)) : k.h - k.l));
  return rma(tr, p);
}

export function adx(cs, p = 14) {
  const pdm = [0], mdm = [0], tr = [cs[0].h - cs[0].l];
  for (let i = 1; i < cs.length; i++) {
    const up = cs[i].h - cs[i - 1].h, dn = cs[i - 1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  const atrv = rma(tr, p), pd = rma(pdm, p), md = rma(mdm, p);
  const dx = cs.map((_, i) => {
    const pdi = (100 * pd[i]) / atrv[i], mdi = (100 * md[i]) / atrv[i];
    return pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  });
  return rma(dx.map((x) => (Number.isNaN(x) ? 0 : x)), p);
}

// For each time T: index of the last candle of `cs` closed at or before T (ct < T).
export function lastClosed(cs) {
  let p = -1;
  return (T) => {
    while (p + 1 < cs.length && cs[p + 1].ct < T) p++;
    return p;
  };
}

// ---- execution on 5m candles ----
// order: { a, side:+1|-1, type:'market'|'stop'|'limit', price?, exp?, sl, tp?|tpR?, trail?, exitIdx }
export function execute(m5, o, cost) {
  const L = o.side;
  const { taker, maker, slip } = cost;
  let f = -1, entry, feeIn;
  if (o.type === 'market') {
    f = o.a;
    entry = m5[f].o * (1 + L * slip);
    feeIn = taker;
  } else {
    for (let i = o.a; i < Math.min(o.a + o.exp, m5.length); i++) {
      const b = m5[i];
      if (o.type === 'stop') {
        if (L > 0 ? b.h >= o.price : b.l <= o.price) {
          f = i;
          entry = (L > 0 ? Math.max(o.price, b.o) : Math.min(o.price, b.o)) * (1 + L * slip);
          feeIn = taker;
          break;
        }
        if (L > 0 ? b.l <= o.sl : b.h >= o.sl) break; // invalidated before trigger
      } else if (L > 0 ? b.l < o.price : b.h > o.price) {
        f = i; // resting limit, must trade through
        entry = o.price;
        feeIn = maker;
        break;
      }
    }
  }
  if (f < 0) return null;
  const risk = Math.abs(entry - o.sl);
  if (!(risk > 0) || L * (entry - o.sl) <= 0) return null;
  const tp = o.tpR != null ? entry + L * o.tpR * risk : o.tp;
  if (tp != null && L * (tp - entry) <= 0) return null;
  let stop = o.sl, best = entry, exit, feeOut, why, i = f;
  for (; i < m5.length; i++) {
    const b = m5[i];
    if (L > 0 ? b.l <= stop : b.h >= stop) {
      const gap = i > f && (L > 0 ? b.o < stop : b.o > stop);
      exit = (gap ? b.o : stop) * (1 - L * slip);
      feeOut = taker;
      why = stop === o.sl ? 'SL' : 'TRAIL';
      break;
    }
    if (tp != null && (L > 0 ? b.h >= tp : b.l <= tp)) {
      exit = tp;
      feeOut = maker;
      why = 'TP';
      break;
    }
    if (i >= o.exitIdx) {
      exit = b.c * (1 - L * slip);
      feeOut = taker;
      why = 'TIME';
      break;
    }
    if (o.trail) {
      best = L > 0 ? Math.max(best, b.h) : Math.min(best, b.l);
      const t = best - L * o.trail;
      if (L * (t - stop) > 0) stop = t;
    }
  }
  if (exit == null) return null;
  const pnl = L * (exit - entry);
  const fees = entry * feeIn + exit * feeOut;
  return { t: m5[f].t, side: L, entry, risk, slPct: risk / entry, grossR: pnl / risk, feeR: fees / risk, netR: (pnl - fees) / risk, why, exitIdx: i };
}

// One position at a time.
export function run(m5, orders, cost) {
  orders.sort((x, y) => x.a - y.a);
  const trades = [];
  let busy = -1;
  for (const o of orders) {
    if (o.a <= busy || o.a >= m5.length) continue;
    const r = execute(m5, o, cost);
    if (!r) continue;
    trades.push(r);
    busy = r.exitIdx;
  }
  return trades;
}

export function stats(trades, days) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const sum = (f) => trades.reduce((s, t) => s + f(t), 0);
  const pos = sum((t) => Math.max(t.netR, 0)), neg = -sum((t) => Math.min(t.netR, 0));
  let cum = 0, peak = 0, dd = 0, eq = 1, eqPeak = 1, eqDD = 0;
  const months = {};
  for (const t of trades) {
    cum += t.netR;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    eq *= 1 + 0.01 * t.netR; // 1% risk per trade, compounding
    eqPeak = Math.max(eqPeak, eq);
    eqDD = Math.max(eqDD, 1 - eq / eqPeak);
    const m = new Date(t.t).toISOString().slice(0, 7);
    months[m] = (months[m] || 0) + t.netR;
  }
  const ms = Object.values(months);
  const sorted = trades.map((t) => t.slPct).sort((a, b) => a - b);
  return {
    n,
    perWeek: +((n / days) * 7).toFixed(1),
    win: Math.round((trades.filter((t) => t.netR > 0).length / n) * 100),
    grossR: +(sum((t) => t.grossR) / n).toFixed(3),
    feeR: +(sum((t) => t.feeR) / n).toFixed(3),
    avgR: +(sum((t) => t.netR) / n).toFixed(3),
    totR: +cum.toFixed(1),
    pf: +(neg ? pos / neg : 99).toFixed(2),
    ddR: +dd.toFixed(1),
    eq1pct: +((eq - 1) * 100).toFixed(1),
    eqDD: +(eqDD * 100).toFixed(1),
    posMonths: `${ms.filter((x) => x > 0).length}/${ms.length}`,
    slPctMed: +(sorted[Math.floor(n / 2)] * 100).toFixed(2),
  };
}
