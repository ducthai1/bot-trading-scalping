#!/usr/bin/env node
// Backtest with the SAME engine as the live bot.
//   node swing/src/backtest.js [--from 2020-01-01] [--capital 100] [--refresh]
// First run downloads ~800 requests of public spot klines (paced, ~4 min) into <dataDir>/cache.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { klinesRange } from './binance.js';
import { simulate, summarize } from './sim.js';
import { tradeStats } from './report.js';
import { DAY } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const cfg = loadConfig(ROOT);
cfg.capital = Number(opt('capital', cfg.capital));
const from = Date.parse(opt('from', '2020-01-01'));
const refresh = argv.includes('--refresh');
const cacheDir = path.join(cfg.dataDir, 'cache');
mkdirSync(cacheDir, { recursive: true });

async function cached(sym, interval) {
  const file = path.join(cacheDir, `${sym}_${interval}.json`);
  const now = Date.now();
  let rows = !refresh && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const start = rows.length ? rows.at(-1).t + 1 : Date.UTC(2017, 6, 1);
  if (now - start > (interval === '1d' ? DAY : 4 * 3600e3)) {
    const fresh = await klinesRange(sym, interval, start, now);
    rows = [...rows, ...fresh].filter((k) => k.ct < now);
    writeFileSync(file, JSON.stringify(rows));
  }
  return rows;
}

const daily = {}, intraday = {};
for (const s of cfg.coins) {
  process.stdout.write(`\rTải dữ liệu ${s.padEnd(10)}`);
  try {
    daily[s] = await cached(s, '1d');
    intraday[s] = await cached(s, '4h');
  } catch (e) {
    console.warn(`\n⚠️ ${s}: ${e.message} — bỏ qua`);
  }
}
console.log('\n');
const r = simulate({ cfg, daily, intraday, from });
const s = summarize(r);
const f = (x, d = 1) => (x == null ? '-' : x.toFixed(d));
console.log(`Backtest ${new Date(r.days[0]).toISOString().slice(0, 10)} → ${new Date(r.days.at(-1)).toISOString().slice(0, 10)} · vốn ${cfg.capital}$ → ${s.final.toFixed(2)}$`);
console.log(`Lợi nhuận ${f(s.cagr)}%/năm · sụt vốn tối đa ${f(s.maxDD)}%${r.breakers.length ? ` · CẦU DAO NGẮT ngày ${new Date(r.breakers[0].at).toISOString().slice(0, 10)}` : ''}`);
console.log('Từng năm:', s.byYear.map(([y, v]) => `${y} ${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join(' | '));
for (const k of ['R3', 'BREAKOUT']) {
  const t = tradeStats(r.trades.filter((x) => x.strategy === k));
  console.log(`${k.padEnd(8)}: ${t.n} lệnh · thắng ${f(t.win)}% · TB ${f(t.avgRet, 2)}%/lệnh${k === 'BREAKOUT' ? ` · chạm TP ${f(t.tpRate)}% · ${f(t.avgR, 2)}R` : ''} · tệ nhất ${f(t.worst)}%`);
}
const sig = [...r.signals.values()];
for (const k of ['R3', 'BREAKOUT']) {
  const done = sig.filter((x) => x.strategy === k && x.result);
  console.log(`Chỉ báo ${k}: ${done.length} tín hiệu có kết quả, đúng ${f((done.filter((x) => x.result.ret > 0).length / done.length) * 100)}%`);
}
