import { readFileSync } from 'node:fs';
import { simulate } from '/app/swing/src/sim.js';
const cfg = { ...JSON.parse(readFileSync('/app/swing/config.json', 'utf8')), capital: 100000, slotsTotal: 6 };
cfg.breakout = { ...cfg.breakout, enabled: false };
const D = { ...JSON.parse(readFileSync('/app/_sbx/data/2y/spot.json', 'utf8')), ...JSON.parse(readFileSync('/app/_sbx/data/2y/spot2.json', 'utf8')) };
const toC = (rows, ms) => rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, ct: t + ms - 1 }));
const daily = Object.fromEntries(cfg.coins.map((s) => [s, toC(D[s]['1d'], 86400e3)]));
const r = simulate({ cfg, daily, from: Date.UTC(2020, 0, 1) });
process.stdout.write(JSON.stringify(r.trades.map((x) => [x.symbol, x.entryTime, +x.ret.toFixed(5), x.days])), () => process.exit(0));
