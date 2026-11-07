// Kiểm tra engine: (1) vào ngẫu nhiên -> trước phí ~0R; (2) biết trước tương lai -> rất dương;
// (3) phí tính đúng: lệnh hoà giá -> netR = -feeR.
import { load, aggregate, atr, run, stats } from './lib.mjs';

const m5 = load(process.argv[2] || 'BTCUSDT');
const c15 = aggregate(m5, 15);
const a15 = atr(c15, 14);
const idx = new Map(m5.map((k, i) => [k.t, i]));
const cost = { taker: 0.0005, maker: 0.0002, slip: 0.0001 };
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const random = [], oracle = [];
for (let j = 50; j < c15.length - 10; j++) {
  const a = idx.get(c15[j].ct + 1);
  if (a == null || rnd() > 0.1) continue;
  const side = rnd() < 0.5 ? 1 : -1;
  const px = m5[a].o, d = a15[j];
  random.push({ a, side, type: 'market', sl: px - side * d, tpR: 1, exitIdx: a + 288 });
  // oracle: hướng của giá 2 giờ sau
  const fut = m5[Math.min(a + 24, m5.length - 1)].c;
  const s2 = fut > px ? 1 : -1;
  oracle.push({ a, side: s2, type: 'market', sl: px - s2 * d, tpR: 1, exitIdx: a + 288 });
}
const r = stats(run(m5, random, cost), 730), o = stats(run(m5, oracle, cost), 730);
console.log('Ngẫu nhiên   :', { n: r.n, 'trước phí R': r.grossR, 'phí R': r.feeR, 'ròng R': r.avgR, 'thắng%': r.win });
console.log('Biết trước   :', { n: o.n, 'trước phí R': o.grossR, 'phí R': o.feeR, 'ròng R': o.avgR, 'thắng%': o.win });
const zero = run(m5, random.slice(0, 200), { taker: 0, maker: 0, slip: 0 });
const zs = stats(zero, 730);
console.log('Không phí    :', { n: zs.n, 'trước phí R': zs.grossR, 'phí R': zs.feeR, 'ròng R': zs.avgR });
