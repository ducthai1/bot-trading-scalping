// Live bot: every minute (+closeDelayMs) evaluate the trigger TFs whose candle just closed.
import { loadConfig, checkNotional } from './config.js';
import { fetchKlines } from './binance.js';
import { evaluate } from './strategy.js';
import { formatAlert } from './format.js';
import { sendTelegram } from './telegram.js';

const dry = process.argv.includes('--dry');
const cfg = loadConfig();
const sent = new Set();
const ts = (ms) => new Date(ms).toLocaleString('vi-VN', { hour12: false });

checkNotional(cfg);
if (!dry && (!cfg.telegram.token || !cfg.telegram.chatId)) {
  console.error('Thiếu Telegram token/chatId (config.json hoặc env TELEGRAM_TOKEN, TELEGRAM_CHAT_ID). Chạy thử: npm run dry');
  process.exit(1);
}

async function tick(force = false) {
  const minute = Math.floor(Date.now() / 60000);
  const tfs = cfg.triggerTimeframes.filter((tf) => force || minute % parseInt(tf, 10) === 0);
  if (!tfs.length) return;

  const [h1, m15] = await Promise.all([fetchKlines('1h'), fetchKlines('15m')]);
  for (const tf of tfs) {
    const candles = await fetchKlines(tf);
    const r = evaluate({ h1, m15, candles, tf, cfg });
    const at = ts(candles[candles.length - 1].ct + 1);
    if (r.noSignal) {
      console.log(`[${at}] ${tf} NO_SIGNAL — ${r.reason}`);
      continue;
    }
    if (sent.has(r.signal.key)) continue; // one alert per pullback wave
    sent.add(r.signal.key);
    const text = formatAlert(r.signal, cfg);
    console.log(`[${at}] ${tf} SIGNAL\n${text}`);
    if (!dry) await sendTelegram(cfg.telegram.token, cfg.telegram.chatId, text);
  }
}

function schedule() {
  const now = Date.now();
  const next = Math.ceil((now + 1) / 60000) * 60000 + cfg.closeDelayMs;
  setTimeout(async () => {
    try {
      await tick();
    } catch (e) {
      console.error(`[${ts(Date.now())}] Lỗi: ${e.message}`);
    }
    schedule();
  }, next - now);
}

console.log(`Bot EMA Ribbon BTCUSDT chạy${dry ? ' (DRY - không gửi Telegram)' : ''}. Khung: ${cfg.triggerTimeframes.join(', ')}`);
tick(true).catch((e) => console.error(`Lỗi: ${e.message}`)).finally(schedule);
