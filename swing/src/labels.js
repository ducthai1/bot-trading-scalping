export const SKIP_REASON = {
  btc_filter: 'BTC đang dưới SMA200 (đứng ngoài)',
  breaker: 'Cầu dao đang ngắt (sụt vốn quá ngưỡng)',
  already_holding: 'Đang giữ coin này ở chiến lược này',
  slots_full: 'Đã đủ số lệnh tối đa',
  max_new_per_day: 'Đã mở đủ số lệnh mới trong ngày',
  not_trading: 'Coin tạm ngừng giao dịch trên Binance',
  late: 'Quá trễ so với giờ mở cửa (bot không chạy kịp)',
  no_price: 'Không lấy được giá',
  invalid_sl: 'SL không hợp lệ',
  below_min_order: 'Dưới lệnh tối thiểu của Binance',
  disabled: 'Chiến lược đang tắt',
};

export const EXIT_REASON = {
  'RSI2>70': 'RSI(2) > 70 — giá đã bật lại',
  TP: 'Chạm TP',
  SL: 'Chạm SL',
  TIME: 'Quá thời gian giữ tối đa',
};

export const STRAT_NAME = { R3: 'R3', BREAKOUT: 'Breakout' };
