// Usage: npm run backtest -- <days>   (default 7). Replays closed candles through evaluate().
import { loadConfig, checkNotional } from './config.js';
import { fetchRange } from './binance.js';
import { evaluate } from './strategy.js';
import { SignalGate } from './signal-gate.js';

const WIN = 300;
const MS = { '1h': 3600000, '15m': 900000, '5m': 300000, '3m': 180000 };
const days = Number(process.argv[2]) || 7;
const cfg = loadConfig();
const end = Date.now();
const start = end - days * 86400000;

checkNotional(cfg);
const tfs = ['1h', '15m', ...cfg.triggerTimeframes];
const data = {};
for (const tf of tfs) data[tf] = await fetchRange(tf, start - WIN * MS[tf], end);

// Index of the last candle whose close time <= t (pointer walks forward).
function cursor(arr) {
  let p = -1;
  return (t) => {
    while (p + 1 < arr.length && arr[p + 1].ct <= t) p++;
    return p;
  };
}

// Pass 1: every trigger timeframe. Pass 2: the cross-timeframe cooldown, in time order, like live.
const found = [];
for (const tf of cfg.triggerTimeframes) {
  const cs = data[tf];
  const at1 = cursor(data['1h']);
  const at15 = cursor(data['15m']);
  const reasons = {};
  const signals = [];
  const seen = new Set();
  for (let i = WIN; i < cs.length; i++) {
    const t = cs[i].ct;
    const p1 = at1(t);
    const p15 = at15(t);
    const r = evaluate({
      h1: data['1h'].slice(Math.max(0, p1 - WIN + 1), p1 + 1),
      m15: data['15m'].slice(Math.max(0, p15 - WIN + 1), p15 + 1),
      candles: cs.slice(i - WIN + 1, i + 1),
      tf,
      cfg,
    });
    if (r.noSignal) {
      const key = r.reason.replace(/(?<![A-Za-z\d])\d+(\.\d+)?(?![Hm\d])/g, '#');
      reasons[key] = (reasons[key] || 0) + 1;
    } else if (!seen.has(r.signal.key)) {
      seen.add(r.signal.key);
      signals.push(r.signal);
    }
  }
  found.push(...signals);
  console.log(`\n===== ${tf} | ${days} ngày | ${cs.length - WIN} nến | ${signals.length} tín hiệu =====`);
  console.log('-- Lý do NO_SIGNAL --');
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);
}

const gate = new SignalGate(cfg);
console.log(`\n===== Tín hiệu sau cooldown ${cfg.cooldownMin} phút (đúng như bot live gửi) =====`);
for (const s of found.sort((a, b) => a.time - b.time)) {
  const blocked = gate.check(s.time + 1) > 0 ? '  [bị chặn: cooldown]' : '';
  console.log(`${new Date(s.time + 1).toISOString()} ${s.tf} ${s.side} entry=${s.entry} sl=${s.sl} tp1=${s.tp1} tp2=${s.tp2} (pb=${s.pbCount}, EMA${s.touchedEma})${blocked}`);
}
