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

// Size at the current price: quantity is rounded down to the 0.001 BTC step, and fees are what a
// 10–20 giá SL has to beat (Market entry + Market/stop exit, both taker).
export function checkSize(cfg, price) {
  const qty = Math.floor((cfg.capital * cfg.leverage) / price / cfg.minQty + 1e-9) * cfg.minQty;
  if (qty < cfg.minQty) {
    console.warn(`⚠️ Giá ${price}: ${cfg.capital}$ x ${cfg.leverage}x không đủ mua ${cfg.minQty} BTC (cần ${(price * cfg.minQty).toFixed(2)}$ notional).`);
    return;
  }
  const fee = price * qty * 2 * cfg.takerFee;
  const feePts = price * 2 * cfg.takerFee;
  const warn = feePts > cfg.slMax ? '⚠️' : 'ℹ️';
  console.log(`${warn} Khối lượng ${qty.toFixed(3)} BTC (~${(price * qty).toFixed(2)}$). Phí vào+ra ~${fee.toFixed(3)}$ ≈ ${feePts.toFixed(0)} giá (SL ${cfg.slMin}–${cfg.slMax} giá).`);
}
