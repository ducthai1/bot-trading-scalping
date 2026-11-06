// Telegram alert — template from section 6 of the spec (HTML parse mode).
const p = (v) => v.toFixed(1);

export function formatAlert(s, cfg) {
  return [
    `🚨 <b>TÍN HIỆU ${s.side} BTCUSDT - BINANCE</b> 🚨`,
    `⏱ Khung: ${s.tf} | Đại cục [15m]: ${s.htfTrend}`,
    '',
    `🎯 <b>Vùng Killzone:</b> Giá đã chạm EMA ${s.touchedEma} sau nhịp hồi ${s.pbCount} nến và đóng nến ${s.color} từ chối giá.`,
    `⚡️ <b>Action:</b> Vào ngay lệnh Market!`,
    '',
    `💰 <b>Entry:</b> ${p(s.entry)}`,
    `🛑 <b>Stop-loss:</b> ${p(s.sl)} (Bắt buộc cài ngay!)`,
    `⛳️ <b>Take-profit 1 (Huề vốn 50%):</b> ${p(s.tp1)}`,
    `⛳️ <b>Take-profit 2 (Kỳ vọng):</b> ${p(s.tp2)}`,
    '',
    `⚠️ <i>Kỷ luật thép: Vốn siêu nhỏ - Đòn bẩy ${cfg.leverage}x Isolated.</i>`,
  ].join('\n');
}
