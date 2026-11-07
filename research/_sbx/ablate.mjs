// Chạy nhiều biến thể config trên cùng bộ dữ liệu, in bảng so sánh.
// node _sbx/ablate.mjs '<json array of [name, overrides]>'
import { execFileSync } from 'node:child_process';

const variants = JSON.parse(process.argv[2]);
const rows = [];
for (const [name, ov] of variants) {
  const out = execFileSync('node', ['_sbx/analyze.mjs', name], {
    env: { ...process.env, CFG: JSON.stringify(ov) },
    maxBuffer: 64e6,
  });
  const d = JSON.parse(out);
  const r = d.results;
  const wins = (r['TP1+TP2'] || 0) + (r['TP1+BE'] || 0) + (r['TP1+timeout'] || 0);
  rows.push({
    variant: name,
    sig: d.signals,
    gated: d.gated,
    SL: r.SL || 0,
    'TP1+BE': r['TP1+BE'] || 0,
    'TP1+TP2': r['TP1+TP2'] || 0,
    timeout: (r.timeout || 0) + (r['TP1+timeout'] || 0),
    'hitTP1%': d.signals ? Math.round((wins / d.signals) * 100) : 0,
    'gross$': d.grossUsd,
    'fees$': d.feesUsd,
    'net$': d.netUsd,
    slMed: d.slDistMedian,
  });
}
console.table(rows);
