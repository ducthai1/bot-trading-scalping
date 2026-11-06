import { loadConfig } from './config.js';
import { sendTelegram } from './telegram.js';
import { formatAlert } from './format.js';

const cfg = loadConfig();
if (!cfg.telegram.token || !cfg.telegram.chatId) {
  console.error('❌ Thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID (trong .env hoặc config.json).');
  console.error('👉 Hãy tạo file .env dựa trên .env.example rồi chạy lại.');
  process.exit(1);
}

const mockSignal = {
  side: 'LONG',
  tf: '3m',
  htfTrend: 'Uptrend',
  touchedEma: 13,
  pbCount: 6,
  color: 'Xanh',
  entry: 98450.0,
  sl: 98435.0,
  tp1: 98510.0,
  tp2: 98550.0,
};

const message = formatAlert(mockSignal, cfg);

console.log('📡 Đang gửi mẫu Alert Tín Hiệu kiểm tra đến Telegram...');
console.log('--- NỘI DUNG MẪU SẼ GỬI ---');
console.log(message);
console.log('---------------------------');

try {
  await sendTelegram(cfg.telegram.token, cfg.telegram.chatId, message);
  console.log('✅ Gửi mẫu tín hiệu thành công! Vui lòng kiểm tra Telegram.');
} catch (err) {
  console.error('❌ Lỗi khi gửi Telegram:', err.message);
  if (err.message.includes('401')) {
    console.error('👉 Lỗi 401 Unauthorized: TELEGRAM_TOKEN sai hoặc không tồn tại.');
  } else if (err.message.includes('chat not found')) {
    console.error('👉 Lỗi chat not found: Bạn chưa ấn /start với bot, hoặc chưa thêm bot vào nhóm.');
  }
}


