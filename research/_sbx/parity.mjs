// Chạy engine mới của bot (swing/src/sim.js) trên đúng dữ liệu nghiên cứu, so với kết quả đã báo cáo.
import { readFileSync } from 'node:fs';
import { simulate, summarize } from '/app/swing/src/sim.js';
const cfg = JSON.parse(readFileSync('/app/swing/config.json', 'utf8'));
cfg.capital = 100000; // vốn lớn để không bị giới hạn lệnh tối thiểu (giống nghiên cứu)
const A = JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8'));
const B = JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8'));
const D = { ...A, ...B };
const toC = (rows, ms) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, ct: t + ms - 1 }));
const daily = {}, intraday = {};
for (const s of cfg.coins) { daily[s] = toC(D[s]['1d'], 86400e3); intraday[s] = toC(D[s]['4h'], 4 * 3600e3); }
const variants = process.argv[2] === 'all' ? [['Ghép R3 + Breakout', {}], ['Chỉ R3', { breakout: { ...cfg.breakout, enabled: false }, slotsTotal: 6 }], ['Chỉ Breakout (tắt cầu dao để so với nghiên cứu)', { r3: { ...cfg.r3, enabled: false }, slotsTotal: 6, circuitBreakerDrawdown: 1 }]] : [['Ghép R3 + Breakout', {}]];
for (const [name, ov] of variants) {
  const c = { ...cfg, ...ov };
  const r = simulate({ cfg: c, daily, intraday, from: Date.UTC(2020, 0, 1) });
  const s = summarize(r);
  console.log(`\n== ${name}: ${s.cagr.toFixed(1)}%/năm | sụt max ${s.maxDD.toFixed(1)}% | từng năm: ${s.byYear.map(([y, v]) => `${y} ${v >= 0 ? '+' : ''}${v.toFixed(0)}%`).join(', ')}`);
  console.log(`   R3: ${s.R3.n} lệnh, thắng ${s.R3.win?.toFixed(1)}%, TB ${s.R3.avgRet?.toFixed(2)}%/lệnh | Breakout: ${s.BREAKOUT.n} lệnh, chạm TP ${s.BREAKOUT.tp?.toFixed(1)}%, TB ${s.BREAKOUT.avgR?.toFixed(2)}R/lệnh`);
  const sig = [...r.signals.values()];
  const res = sig.filter((x) => x.result);
  console.log(`   Sổ tín hiệu: ${sig.length} tín hiệu, ${res.length} đã có kết quả, đúng ${(res.filter((x) => x.result.ret > 0).length / res.length * 100).toFixed(1)}% | lý do bỏ qua: ${JSON.stringify(sig.filter((x) => x.status === 'skipped').reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {}))}`);
}
