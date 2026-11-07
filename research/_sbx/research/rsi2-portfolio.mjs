// Danh mục RSI(2) Connors LONG với vốn chung bằng tiền thật.
// - Tín hiệu: close > SMA200 và RSI(2) < 5 -> mua lúc mở cửa hôm sau; bán lúc mở cửa hôm sau khi close > SMA5.
// - Tối đa 3 lệnh cùng lúc, mỗi lệnh = 1/3 tổng tài sản (đánh giá theo giá đóng cửa hôm trước), không đòn bẩy.
// - Nhiều tín hiệu cùng ngày: ưu tiên RSI(2) thấp nhất.
// - Khối lượng làm tròn theo bước lot; dưới mức tối thiểu của sàn -> bỏ lệnh (ghi nhận là "bỏ lỡ").
// - Cắt lỗ thảm hoạ (tuỳ chọn): stop ở entry*(1-x), khớp ở giá stop hoặc giá mở cửa nếu gap.
// - futures: phí 0.05%/chiều + funding thật | spot: phí 0.1%/chiều, không funding (giá dùng nến futures làm xấp xỉ).
import { readFileSync } from 'node:fs';

const DAY = 86400e3;
const START = Date.UTC(2020, 0, 1);
const D = JSON.parse(readFileSync('/app/_sbx/data/2y/daily.json', 'utf8'));
const FILTERS = JSON.parse(readFileSync('/app/_sbx/data/2y/filters.json', 'utf8'));
const SYMS = Object.keys(D);
const SLIP = (s) => (s === 'BTCUSDT' || s === 'ETHUSDT' ? 0.0002 : 0.0005);
let SLOTS = Number(process.env.SLOTS || 3);
const TH = 5;

const sma = (v, p) => v.map((_, i) => (i < p - 1 ? NaN : v.slice(i - p + 1, i + 1).reduce((a, b) => a + b, 0) / p));
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

// Per-coin series keyed by day.
const coin = {};
for (const s of SYMS) {
  const k = D[s].k.map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const c = k.map((x) => x.c);
  const s200 = sma(c, 200), s5 = sma(c, 5), r = rsi(c, 2);
  const byDay = new Map(k.map((x, i) => [x.t, { ...x, s200: s200[i], s5: s5[i], rsi: r[i] }]));
  const fund = new Map();
  for (const [t, rate] of D[s].f) {
    const d = Math.floor(t / DAY) * DAY;
    fund.set(d, (fund.get(d) || 0) + rate);
  }
  coin[s] = { byDay, fund };
}
const days = [...new Set(SYMS.flatMap((s) => [...coin[s].byDay.keys()]))].filter((t) => t >= START).sort((a, b) => a - b);

function run({ capital, market, stopPct }) {
  const fee = market === 'spot' ? 0.001 : 0.0005;
  let cash = capital;
  const pos = new Map(); // sym -> { qty, entry, stop, t }
  const trades = [];
  let skipped = 0, skippedMin = 0, signals = 0, pendingBuy = [], pendingSell = new Set();
  let eqPrev = capital, peak = capital, dd = 0;
  const equityAt = (d, px = 'c') => cash + [...pos].reduce((s, [sym, p]) => s + p.qty * (coin[sym].byDay.get(d)?.[px] ?? p.entry), 0);
  const close = (sym, px, d, why) => {
    const p = pos.get(sym);
    const exit = px * (1 - SLIP(sym));
    cash += p.qty * exit * (1 - fee);
    trades.push({ sym, d, entry: p.entry, exitPx: exit, t: p.t, ret: (exit * (1 - fee)) / (p.entry * (1 + fee)) - 1 - p.funding / (p.qty * p.entry), why });
    pos.delete(sym);
  };
  for (const d of days) {
    // 1) open: exits decided yesterday, then entries (lowest RSI first)
    for (const sym of pendingSell) if (pos.has(sym) && coin[sym].byDay.has(d)) close(sym, coin[sym].byDay.get(d).o, d, 'SMA5');
    pendingSell = new Set();
    for (const { sym } of pendingBuy.sort((a, b) => a.rsi - b.rsi)) {
      const b = coin[sym].byDay.get(d);
      if (!b || pos.has(sym)) continue;
      signals++;
      if (pos.size >= SLOTS) {
        skipped++;
        continue;
      }
      const entry = b.o * (1 + SLIP(sym));
      const f = FILTERS[sym][market];
      const alloc = Math.min(eqPrev / SLOTS, cash / (1 + fee));
      const qty = Math.floor(alloc / entry / f.step + 1e-9) * f.step;
      if (qty < f.minQty || qty * entry < f.minNotional) {
        skipped++;
        skippedMin++;
        continue;
      }
      cash -= qty * entry * (1 + fee);
      pos.set(sym, { qty, entry, stop: stopPct ? entry * (1 - stopPct) : null, t: d, funding: 0 });
    }
    pendingBuy = [];
    // 2) intraday: disaster stop; 3) funding (futures, longs pay positive rates)
    for (const [sym, p] of [...pos]) {
      const b = coin[sym].byDay.get(d);
      if (!b) continue;
      if (p.stop && b.l <= p.stop) {
        close(sym, Math.min(p.stop, b.o), d, 'STOP');
        continue;
      }
      if (market === 'futures') {
        const pay = p.qty * b.o * (coin[sym].fund.get(d) || 0);
        cash -= pay;
        p.funding += pay;
      }
    }
    // 4) close: mark equity, generate tomorrow's orders
    const eq = equityAt(d);
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
    eqPrev = eq;
    for (const sym of SYMS) {
      const b = coin[sym].byDay.get(d);
      if (!b || Number.isNaN(b.s200)) continue;
      if (pos.has(sym)) {
        if (b.c > b.s5) pendingSell.add(sym);
      } else if (b.c > b.s200 && b.rsi < TH) pendingBuy.push({ sym, rsi: b.rsi });
    }
  }
  const years = (days.at(-1) - days[0]) / (365.25 * DAY);
  const final = equityAt(days.at(-1));
  const wins = trades.filter((t) => t.ret > 0);
  return {
    list: trades,
    final,
    cagr: ((final / capital) ** (1 / years) - 1) * 100,
    dd: dd * 100,
    trades: trades.length,
    takenPct: signals ? ((signals - skipped) / signals) * 100 : 0,
    missedSmallPct: signals ? (skippedMin / signals) * 100 : 0,
    win: (wins.length / trades.length) * 100,
    exp: (trades.reduce((s, t) => s + t.ret, 0) / trades.length) * 100,
    worst: Math.min(...trades.map((t) => t.ret)) * 100,
    stops: trades.filter((t) => t.why === 'STOP').length,
    yearly: Object.fromEntries(
      [...new Set(trades.map((t) => new Date(t.t).getUTCFullYear()))].map((y) => {
        const ts = trades.filter((t) => new Date(t.t).getUTCFullYear() === y);
        return [y, +(ts.reduce((s, t) => s + t.ret, 0) * (100 / SLOTS)).toFixed(1)];
      })
    ),
  };
}

const f1 = (x) => x.toFixed(1);
if (process.env.MODE === 'stats') {
  for (const slots of [6, 12]) {
    SLOTS = slots;
    const r = run({ capital: 1000, market: 'spot', stopPct: 0 });
    const L = r.list.map((t) => ({ ...t, hold: Math.round((t.d - t.t) / DAY) })).sort((a, b) => a.t - b.t);
    const rets = L.map((t) => t.ret * 100).sort((a, b) => a - b);
    const q = (p) => rets[Math.min(rets.length - 1, Math.floor(p * rets.length))];
    const yrs = (days.at(-1) - days[0]) / (365.25 * DAY);
    const byMonth = {};
    for (const t of L) { const m = new Date(t.t).toISOString().slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; }
    const allMonths = new Set(days.map((d) => new Date(d).toISOString().slice(0, 7)));
    const perMonth = [...allMonths].map((m) => byMonth[m] || 0);
    const entryDays = {};
    for (const t of L) entryDays[t.t] = (entryDays[t.t] || 0) + 1;
    let maxGap = 0;
    for (let k = 1; k < L.length; k++) maxGap = Math.max(maxGap, (L[k].t - L[k - 1].t) / DAY);
    let maxOpen = 0;
    for (const d of days) maxOpen = Math.max(maxOpen, L.filter((t) => t.t <= d && t.d > d).length);
    let streak = 0, maxStreak = 0;
    for (const t of L) { streak = t.ret <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); }
    const wins = L.filter((t) => t.ret > 0), loss = L.filter((t) => t.ret <= 0);
    const avg = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
    console.log(JSON.stringify({
      slots, trades: L.length, perYear: +(L.length / yrs).toFixed(1), perMonthAvg: +(L.length / (yrs * 12)).toFixed(1),
      monthsWithZero: perMonth.filter((x) => x === 0).length + '/' + perMonth.length, maxInOneMonth: Math.max(...perMonth),
      maxEntriesSameDay: Math.max(...Object.values(entryDays)), longestGapDays: Math.round(maxGap), maxOpenAtOnce: maxOpen,
      holdAvg: +avg(L, (t) => t.hold).toFixed(1), holdMax: Math.max(...L.map((t) => t.hold)),
      win: +(wins.length / L.length * 100).toFixed(1), avgWin: +avg(wins, (t) => t.ret * 100).toFixed(2), avgLoss: +avg(loss, (t) => t.ret * 100).toFixed(2),
      expectancy: +avg(L, (t) => t.ret * 100).toFixed(2), median: +q(0.5).toFixed(2), p10: +q(0.1).toFixed(2), p90: +q(0.9).toFixed(2),
      best: +rets.at(-1).toFixed(1), worst: +rets[0].toFixed(1), lossesOver10pct: rets.filter((x) => x <= -10).length, maxLosingStreak: maxStreak,
      cagr: +r.cagr.toFixed(1), dd: +r.dd.toFixed(1),
    }));
  }
} else if (process.env.MODE === 'debug') {
  const r = run({ capital: 10000, market: 'spot', stopPct: 0.1 });
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  for (const t of r.list.filter((x) => x.why === 'STOP').slice(0, 5)) {
    const b = coin[t.sym].byDay.get(t.d);
    console.log(`${t.sym} vào ${day(t.t)} @${t.entry.toPrecision(6)} (stop ${(t.entry * 0.9).toPrecision(6)}) | ngày stop ${day(t.d)} mở ${b.o} thấp ${b.l} đóng ${b.c} -> ra @${t.exitPx.toPrecision(6)} (${(t.ret * 100).toFixed(1)}%)`);
    const after = [1, 3, 5].map((n) => coin[t.sym].byDay.get(t.d + n * DAY)?.c);
    console.log(`   giá đóng cửa sau 1/3/5 ngày: ${after.join(' / ')}`);
  }
} else {
  const rows = [];
  for (const slots of [3, 6, 12]) {
    SLOTS = slots;
    for (const market of ['spot', 'futures']) {
      for (const stopPct of [0, 0.15]) {
        const r = run({ capital: 100000, market, stopPct });
        // smallest capital that misses < 1% of signals
        let need = null;
        for (const c of [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 750, 1000]) {
          if (run({ capital: c, market, stopPct }).missedSmallPct < 1) { need = c; break; }
        }
        rows.push({ 'số lệnh tối đa': slots, 'mỗi lệnh': `1/${slots} vốn`, thị_trường: market, 'cắt lỗ': stopPct ? '-15%' : 'không', lệnh: r.trades, 'thắng %': f1(r.win), 'kỳ vọng %/lệnh': r.exp.toFixed(2), 'lệnh tệ nhất %': f1(r.worst), 'lợi nhuận %/năm': f1(r.cagr), 'sụt vốn max %': f1(r.dd), 'vốn tối thiểu $ (bỏ lỡ <1%)': need ?? '>1000' });
      }
    }
  }
  console.table(rows);
}
