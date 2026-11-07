# Swing bot R3 + Breakout (Binance spot, khung ngày)

> **Hướng dẫn đầy đủ** (cài đặt, biến môi trường, cơ chế, bảo trì, xử lý sự cố): [`../HUONG_DAN.md`](../HUONG_DAN.md)

Bot **chỉ gửi cảnh báo** (Telegram + dashboard) và giữ một **sổ giả lập** để so với backtest. Bot **không đặt lệnh, không dùng API key**.

| Chiến lược | Vào lệnh (nến ngày đã đóng) | Thoát |
|---|---|---|
| **R3** (Connors & Alvarez) | Giá > SMA200, RSI(2) giảm 3 ngày liền (bắt đầu < 60), hôm nay < 10 | Mở cửa hôm sau khi RSI(2) > 70 |
| **Breakout** (Turtle 20 ngày) | Giá đóng cửa vượt đỉnh 20 ngày trước | SL = giá vào − 2 ATR, TP = giá vào + 3×SL (đặt OCO), tối đa 60 ngày |

Chung: chỉ vào lệnh khi **BTC > SMA200**; mỗi chiến lược tối đa 6 lệnh và 2 lệnh mới/ngày; mỗi lệnh = vốn/12; cầu dao dừng mở lệnh mới khi sụt vốn > 50%.
Backtest 2020–2026 (34 coin, phí spot 0.1%): ~30%/năm, sụt vốn tối đa ~40%, năm tệ nhất −5%. Quá khứ không bảo đảm tương lai.

## Chạy

Yêu cầu Node ≥ 20 (Linux hoặc macOS). Không cần cài thêm gói.

```bash
cp .env.example .env              # điền TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (dùng chung với bot cũ)
echo 'SWING_ADMIN_KEY=chuoi-bi-mat' >> .env    # bật nút thao tác trên dashboard
npm run swing:once                # chạy thử 1 lần, không gửi Telegram
pm2 start ecosystem.config.cjs --only swing-bot
pm2 save && pm2 startup           # tự chạy lại khi khởi động máy
```

Dashboard: http://127.0.0.1:3100 (chỉ mở trên máy này; muốn xem từ máy khác đặt `SWING_HOST=0.0.0.0`).
Backtest bằng đúng engine của bot: `npm run swing:backtest -- --from 2020-01-01` (lần đầu tải ~800 request, ~4 phút, có cache).
Test: `npm run test:swing`.

## Cấu hình

Sửa trong `swing/config.local.json` (không commit), ví dụ `{ "capital": 150 }`. Biến môi trường: `SWING_CAPITAL`, `SWING_PORT`, `SWING_HOST`, `SWING_DATA_DIR`, `SWING_TELEGRAM_TOKEN` / `SWING_TELEGRAM_CHAT_ID` (nếu muốn khác bot cũ).

**Vốn tối thiểu:** mỗi lệnh = vốn / 12 phải ≥ 5$ (mức tối thiểu của Binance spot) ⇒ cần **≥ ~65$**, khuyên **100$**. Dưới mức này bot báo lỗi cấu hình và mọi lệnh bị bỏ qua.

## Mỗi ngày

- **07:02 sáng (giờ VN)** bot chốt nến ngày, gửi Telegram: coin cần **BÁN**, coin cần **MUA** (số tiền, khối lượng, giá; Breakout kèm SL/TP để đặt OCO).
- Làm trong buổi sáng: backtest cho thấy trễ 12 giờ mất ~1/3 lợi nhuận, trễ 1 ngày mất một nửa. Quá 8 giờ bot không báo MUA nữa (tín hiệu cũ).
- **Giá realtime** (WebSocket Binance spot, 1 kết nối cho 34 coin, không tốn hạn mức REST): bot theo dõi từng phút
  mọi lệnh thật và lệnh giả định — Breakout chạm SL/TP thì báo Telegram ngay. Phút nào socket bị mất được lấy bù
  qua REST (job mỗi giờ, 0 request khi socket ổn định).
- Dashboard có bảng **"nếu đóng cửa bây giờ"**: coin nào sắp có tín hiệu theo giá hiện tại (chỉ để quan sát).
- Máy tắt/ngủ: khi chạy lại bot tự **chạy bù** — lệnh BÁN của những ngày lỡ được báo ngay, lệnh MUA cũ bị bỏ.

## Dữ liệu (thư mục `swing/data`)

`state.json` (sổ hiện tại), `trades.jsonl` (lệnh đã đóng), `signals.jsonl` (mọi tín hiệu + kết quả giả định),
`equity.jsonl`, `orders.jsonl`, `events.jsonl`. Xuất CSV trên dashboard. Muốn bắt đầu lại: dừng bot, xoá thư mục này.

## Chạy thử 3–6 tuần trước khi dùng tiền thật

Bot tự chấm **mọi** tín hiệu (kể cả không vào lệnh) theo 2 cách và ghi log từng dòng (`📍 tín hiệu`, `🧪 kiểm chứng`, `📈 sau N ngày`):
1. **Đúng/sai theo luật thoát**: lệnh giả định có lãi sau phí không (backtest: R3 72.7%, Breakout 36.3%).
2. **Lợi nhuận sau 1/3/5/10 ngày so với rổ 34 coin**: coin có tín hiệu có chạy hơn thị trường không
   (backtest: Breakout hơn rổ +0.6% sau 5 ngày; R3 ≈ 0 — R3 kiếm tiền nhờ mua lúc cả thị trường giảm, không nhờ chọn coin).

Tab **Kiểm chứng & đánh giá** so với backtest bằng khoảng tin cậy 95% và đưa kết luận tạm; mỗi thứ Hai bot gửi báo cáo tuần.
Cần **≥ 20 tín hiệu có kết quả mỗi chiến lược** (thường 3–6 tuần) mới nên kết luận. Nếu một chiến lược "kém hơn backtest rõ rệt" → chưa dùng tiền thật.

## Dashboard

- **Tổng quan**: vốn, lãi/lỗ, sụt vốn, việc cần làm, lệnh đang mở, **so với backtest** (khoảng tin cậy 95%), đường vốn.
- **Lịch sử lệnh**: lọc theo chiến lược / tháng / lãi-lỗ; MFE/MAE (lãi tạm cao nhất / lỗ tạm sâu nhất).
- **Theo giai đoạn**: tháng, năm, từng chiến lược.
- **Tín hiệu đúng/sai**: mọi tín hiệu (kể cả bị bỏ qua vì đủ lệnh, lọc BTC…) được theo dõi như một lệnh giả định
  để biết chỉ báo đúng hay sai và bộ lọc có giúp không — dữ liệu để tối ưu sau này (cần ≥ 20–30 lệnh mới nên kết luận).

## An toàn

Ghi file nguyên tử (mất điện không hỏng sổ), khoá chống chạy 2 bản, giãn cách request và dừng hẳn khi Binance trả
418/429 (kể cả sau khi pm2 khởi động lại), dùng giờ máy chủ Binance, job lỗi giữa chừng thì sổ được khôi phục nguyên trạng.
