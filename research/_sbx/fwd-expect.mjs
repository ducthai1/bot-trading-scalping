import { readFileSync } from 'node:fs';
import { simulate, summarize } from '/app/swing/src/sim.js';
import { forwardStats } from '/app/swing/src/report.js';
const cfg = { ...JSON.parse(readFileSync('/app/swing/config.json', 'utf8')), capital: 100000 };
const D = { ...JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8')), ...JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8')) };
const toC = (rows, ms) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, ct: t + ms - 1 }));
const daily = {}, intraday = {};
for (const s of cfg.coins) { daily[s] = toC(D[s]['1d'], 86400e3); intraday[s] = toC(D[s]['4h'], 4 * 3600e3); }
const r = simulate({ cfg, daily, intraday, from: Date.UTC(2020, 0, 1) });
const s = summarize(r);
console.log(`Ghép: ${s.cagr.toFixed(1)}%/năm, sụt ${s.maxDD.toFixed(1)}%, R3 ${s.R3.n} lệnh thắng ${s.R3.win.toFixed(1)}%, BO ${s.BREAKOUT.n} lệnh TP ${s.BREAKOUT.tp.toFixed(1)}% ${s.BREAKOUT.avgR.toFixed(2)}R`);
const sig = [...r.signals.values()];
const fs = forwardStats(sig);
console.table(fs.map((x) => ({ strategy: x.strategy, h: x.h, n: x.n, coin: x.avgRet?.toFixed(2), basket: x.avgBasket?.toFixed(2), excess: x.avgExcess?.toFixed(2), ci: x.excessCI?.map((v) => v.toFixed(2)).join('..'), beat: x.beatPct?.toFixed(0) })));
for (const k of ['R3', 'BREAKOUT']) { const done = sig.filter((x) => x.strategy === k && x.result); console.log(k, 'chỉ báo đúng', (done.filter((x) => x.result.ret > 0).length / done.length * 100).toFixed(1), '% /', done.length); }
console.log('JSON', JSON.stringify(Object.fromEntries(['R3', 'BREAKOUT'].map((k) => [k, Object.fromEntries(fs.filter((x) => x.strategy === k).map((x) => [x.h, +x.avgExcess.toFixed(2)]))]))));
