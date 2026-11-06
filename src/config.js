import { readFileSync } from 'node:fs';

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  cfg.telegram.token = process.env.TELEGRAM_TOKEN || cfg.telegram.token;
  cfg.telegram.chatId = process.env.TELEGRAM_CHAT_ID || cfg.telegram.chatId;
  return cfg;
}

export function checkNotional(cfg) {
  const notional = cfg.capital * cfg.leverage;
  const msg = `Vốn ${cfg.capital}$ x ${cfg.leverage}x = ${notional.toFixed(2)}$ notional`;
  if (notional < cfg.minNotional) {
    const needCap = Math.ceil((cfg.minNotional / cfg.leverage) * 100) / 100;
    const needLev = Math.ceil(cfg.minNotional / cfg.capital);
    console.warn(`⚠️ ${msg} < ${cfg.minNotional}$ min notional Binance. Cần vốn >= ${needCap}$ hoặc đòn bẩy >= ${needLev}x.`);
  } else {
    console.log(`✅ ${msg}`);
  }
}
