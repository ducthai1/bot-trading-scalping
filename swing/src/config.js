import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency, works on every Node >= 20): KEY=VALUE, # comments, optional quotes.
// Variables already present in the environment win.
export function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].replace(/\s+#.*$/, '');
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

function merge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out && typeof out[k] === 'object' && !Array.isArray(out[k]) ? merge(out[k], v) : v;
  return out;
}

// config.json (committed) <- config.local.json (your overrides, git-ignored) <- env SWING_*
export function loadConfig(root) {
  let cfg = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
  const local = path.join(root, 'config.local.json');
  if (existsSync(local)) cfg = merge(cfg, JSON.parse(readFileSync(local, 'utf8')));
  if (process.env.SWING_CAPITAL) cfg.capital = Number(process.env.SWING_CAPITAL);
  if (process.env.SWING_PORT) cfg.server.port = Number(process.env.SWING_PORT);
  if (process.env.SWING_HOST) cfg.server.host = process.env.SWING_HOST;
  cfg.dataDir = path.resolve(root, process.env.SWING_DATA_DIR || cfg.dataDir);
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errs = [];
  const pos = (v, name) => (typeof v === 'number' && v > 0) || errs.push(`${name} phải là số > 0`);
  pos(cfg.capital, 'capital');
  pos(cfg.slotsTotal, 'slotsTotal');
  pos(cfg.minOrderUsd, 'minOrderUsd');
  if (!Array.isArray(cfg.coins) || !cfg.coins.length) errs.push('coins không được rỗng');
  if (cfg.btcFilter && !cfg.coins.includes('BTCUSDT')) errs.push('btcFilter cần BTCUSDT nằm trong coins');
  if (!(cfg.circuitBreakerDrawdown > 0 && cfg.circuitBreakerDrawdown <= 1)) errs.push('circuitBreakerDrawdown phải trong (0, 1]');
  for (const k of ['r3', 'breakout']) {
    pos(cfg[k].maxPositions, `${k}.maxPositions`);
    pos(cfg[k].maxNewPerDay, `${k}.maxNewPerDay`);
  }
  const slots = (cfg.r3.enabled ? cfg.r3.maxPositions : 0) + (cfg.breakout.enabled ? cfg.breakout.maxPositions : 0);
  if (slots > cfg.slotsTotal) errs.push(`Tổng maxPositions (${slots}) > slotsTotal (${cfg.slotsTotal}): sẽ thiếu tiền cho lệnh cuối`);
  if (errs.length) throw new Error(`Cấu hình swing không hợp lệ:\n - ${errs.join('\n - ')}`);
  const perTrade = cfg.capital / cfg.slotsTotal;
  return perTrade < cfg.minOrderUsd ? `Vốn ${cfg.capital}$ / ${cfg.slotsTotal} = ${perTrade.toFixed(2)}$ mỗi lệnh < tối thiểu ${cfg.minOrderUsd}$ của Binance: mọi lệnh sẽ bị bỏ qua (cần vốn >= ${Math.ceil(cfg.minOrderUsd * cfg.slotsTotal * 1.02)}$)` : null;
}
