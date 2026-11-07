// Chạy A/B/C x biến thể x coin. Năm 1 (train) để chọn biến thể, năm 2 (test) để chấm điểm.
// Quy tắc chọn & tiêu chí "đạt" được chốt ở đây trước khi xem kết quả.
import { load, aggregate, run, stats } from './lib.mjs';
import { VARIANTS, FN } from './strategies.mjs';

const COINS = (process.env.COINS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const SLIP = { BTCUSDT: 0.0001, ETHUSDT: 0.0001, SOLUSDT: 0.0002 };
const MIN_ORDER = { BTCUSDT: 76.13, ETHUSDT: 20, SOLUSDT: 5 }; // lệnh nhỏ nhất thực tế (exchangeInfo 2026-11-07)
const CAPITAL = 4.52;
const DAY = 86400e3;

const res = {}; // res[strat][variant][coin] = { train:[trades], test:[trades] }
const market = {};
for (const sym of COINS) {
  const m5 = load(sym);
  const idx = new Map(m5.map((k, i) => [k.t, i]));
  const ctx = { m5, idx, c15: aggregate(m5, 15), c1h: aggregate(m5, 60), c4h: aggregate(m5, 240), c1d: aggregate(m5, 1440) };
  const cost = { taker: 0.0005, maker: 0.0002, slip: SLIP[sym] };
  const tMid = m5[0].t + 365 * DAY;
  const iMid = idx.get(Math.floor(tMid / 300e3) * 300e3);
  market[sym] = { y1: +((m5[iMid].o / m5[0].o - 1) * 100).toFixed(0), y2: +((m5.at(-1).c / m5[iMid].o - 1) * 100).toFixed(0) };
  for (const [s, vs] of Object.entries(VARIANTS)) {
    for (const v of vs) {
      const trades = run(m5, FN[s](ctx, v), cost);
      ((res[s] ??= {})[v.name] ??= {})[sym] = { train: trades.filter((t) => t.t < tMid), test: trades.filter((t) => t.t >= tMid) };
    }
  }
  process.stderr.write(`${sym} xong\n`);
}

const pool = (byCoin, part) => Object.values(byCoin).flatMap((x) => x[part]).sort((a, b) => a.t - b.t);
const table = (rows) => console.table(rows);
const out = { market, strategies: {} };

console.log('Biến động giá (mua & giữ): ', JSON.stringify(market));
for (const [s, vs] of Object.entries(res)) {
  console.log(`\n================ CHIẾN LƯỢC ${s} — tất cả biến thể, gộp 3 coin ================`);
  const rows = [];
  for (const [name, byCoin] of Object.entries(vs)) {
    const tr = stats(pool(byCoin, 'train'), 365), te = stats(pool(byCoin, 'test'), 365);
    rows.push({ variant: name, 'N1 lệnh': tr.n, 'N1 R/lệnh': tr.avgR, 'N1 PF': tr.pf, 'N2 lệnh': te.n, 'N2 R/lệnh': te.avgR, 'N2 PF': te.pf, 'N2 tổng R': te.totR, 'phí R': te.feeR });
  }
  table(rows);
  // Chọn theo năm 1: R/lệnh gộp cao nhất, cần >= 60 lệnh.
  const pick = rows.filter((r) => r['N1 lệnh'] >= 60).sort((a, b) => b['N1 R/lệnh'] - a['N1 R/lệnh'])[0];
  if (!pick) continue;
  const byCoin = vs[pick.variant];
  console.log(`→ Chọn theo năm 1: "${pick.variant}". Kết quả NĂM 2 (chưa dùng để chọn):`);
  const coinRows = [];
  for (const sym of COINS) {
    const t = stats(byCoin[sym].test, 365);
    const minRisk = t.n ? +(((MIN_ORDER[sym] * t.slPctMed) / 100 / CAPITAL) * 100).toFixed(1) : null;
    coinRows.push({ coin: sym, lệnh: t.n, 'lệnh/tuần': t.perWeek, 'thắng%': t.win, 'trước phí R': t.grossR, 'phí R': t.feeR, 'ròng R/lệnh': t.avgR, PF: t.pf, 'tổng R': t.totR, 'sụt max R': t.ddR, 'vốn +% (rủi ro 1%)': t.eq1pct, 'sụt vốn %': t.eqDD, 'tháng dương': t.posMonths, 'SL% trung vị': t.slPctMed, 'rủi ro tối thiểu với 4.52$ (%)': minRisk });
  }
  const P = stats(pool(byCoin, 'test'), 365);
  coinRows.push({ coin: 'GỘP', lệnh: P.n, 'lệnh/tuần': P.perWeek, 'thắng%': P.win, 'trước phí R': P.grossR, 'phí R': P.feeR, 'ròng R/lệnh': P.avgR, PF: P.pf, 'tổng R': P.totR, 'sụt max R': P.ddR });
  table(coinRows);
  const posCoins = coinRows.filter((r) => r.coin !== 'GỘP' && r['ròng R/lệnh'] > 0).length;
  const pass = P.avgR > 0 && P.pf > 1.1 && posCoins >= 2;
  console.log(`→ ĐẠT? ${pass ? 'CÓ' : 'KHÔNG'} (R/lệnh năm 2 = ${P.avgR} > 0, PF = ${P.pf} > 1.1, dương ở ${posCoins}/3 coin >= 2)`);
  out.strategies[s] = { all: rows, pick: pick.variant, test: coinRows, pass };
}
console.log('@@JSON@@' + JSON.stringify(out));
