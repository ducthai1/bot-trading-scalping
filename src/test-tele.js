import { loadConfig } from './config.js';
import { sendTelegram } from './telegram.js';

const cfg = loadConfig();
if (!cfg.telegram.token || !cfg.telegram.chatId) {
  console.error('❌ Thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID (trong .env hoặc config.json).');
  console.error('👉 Hãy tạo file .env dựa trên .env.example rồi chạy lại.');
  process.exit(1);
}

console.log('📡 Đang gửi tin nhắn kiểm tra đến Telegram...');
try {
  await sendTelegram(
    cfg.telegram.token,
    cfg.telegram.chatId,
    '🔔 <b>Test Bot</b>: Kết nối Telegram thành công!\nBot EMA Ribbon Scalping đã sẵn sàng hoạt động.'
  );
  console.log('✅ Gửi tin nhắn thành công! Vui lòng kiểm tra Telegram.');
} catch (err) {
  console.error('❌ Lỗi khi gửi Telegram:', err.message);
  if (err.message.includes('401')) {
    console.error('👉 Lỗi 401 Unauthorized: TELEGRAM_TOKEN sai hoặc không tồn tại.');
  } else if (err.message.includes('chat not found')) {
    console.error('👉 Lỗi chat not found: Bạn chưa ấn /start với bot, hoặc chưa thêm bot vào nhóm.');
  }
}

