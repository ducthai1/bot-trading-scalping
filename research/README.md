# Research — các backtest dẫn tới swing bot

Code nghiên cứu (không phải bot). Mỗi script đã chạy trong một container Docker cách ly; dữ liệu không được commit
(~90MB) — tải lại bằng các script `fetch-*`. Kết quả tóm tắt bên dưới; phân tích đầy đủ trong `../HUONG_DAN.md`.

## Chạy lại

```bash
docker build -t ducthai-sandbox:base -f research/sandbox/Dockerfile .      # chỉ chứa dependencies
bash research/sandbox/run.sh --net -- 'node _sbx/research/fetch-spot.mjs BTCUSDT,ETHUSDT' > research/_sbx/data/2y/spot.json
bash research/sandbox/run.sh -- 'node _sbx/research/swing.mjs'           # không mạng
```
`run.sh` đóng gói repo + `research/_sbx` vào container (`/app`, `/app/_sbx`), không mount thư mục máy, mặc định không có mạng.
Script đọc dữ liệu ở `/app/_sbx/data/...` — tạo thư mục `research/_sbx/data/2y/` trước khi tải.

| Dữ liệu | Script tải |
|---|---|
| BTC futures 3m/5m/15m/1h 30–180 ngày (`data/klines*.json`) | `_sbx/fetch-data.mjs <days>` |
| BTC/ETH/SOL futures 5m 2 năm (`data/2y/*_5m.json`) | `_sbx/research/fetch5m.mjs <SYM> 730` |
| 12 coin futures nến ngày + funding (`data/2y/daily.json`) | `_sbx/research/fetch-daily.mjs` |
| 34 coin spot 4h + ngày (`data/2y/spot.json`, `spot2.json`) | `_sbx/research/fetch-spot.mjs <danh sách>` |

## Script → câu hỏi → kết luận

| Script | Câu hỏi | Kết luận |
|---|---|---|
| `_sbx/analyze.mjs`, `ablate.mjs` | Bot EMA md (BTC 3m/5m) có lãi? Bộ lọc nào giúp? | 11 lệnh/180 ngày, 10 SL; trước phí ≈ 0; lọc R:R sau phí giảm lỗ ~80% nhưng vẫn âm |
| `_sbx/lockwood.mjs` | Lockwood Scalp gốc trên BTC? | 4–6 lệnh/ngày nhưng −0.03…−0.05R trước phí; phí ≈ 0.3R/lệnh |
| `research/run-all.mjs`, `strategies.mjs`, `lib.mjs`, `sanity.mjs` | Scalping/intraday A (xu hướng), B (breakout phiên), C (mean-reversion limit) 2 năm × BTC/ETH/SOL | Không chiến lược nào đạt out-of-sample; B gần hoà |
| `research/daily.mjs` | Chiến lược kinh điển khung ngày (RSI2, Double 7s, Turtle, Holy Grail, Williams) 12 coin | RSI(2) long: thắng 66%, +1.25%/lệnh; Turtle long lãi nhưng thắng ~30% |
| `research/rsi2-portfolio.mjs` | Danh mục RSI(2), cắt lỗ thảm hoạ, vốn tối thiểu | Cắt lỗ cố định làm hỏng; spot vốn tối thiểu 20–80$ |
| `research/ema-htf.mjs` | EMA 8/13/21 của bot md trên 4h / ngày (spot) | Không có lợi thế (t-stat −1.4 … +0.6) |
| `research/swing.mjs` | Họ Connors (HPETF) trên 34 coin, kiểm chứng coin mới & giai đoạn | **R3** mạnh nhất (thắng 71%, t = 7.1, dương ở coin chưa thấy) |
| `research/r3-risk.mjs` | R3: trễ lệnh, cách giảm lỗ | Lọc BTC > SMA200 + tối đa 2 lệnh mới/ngày: sụt vốn 41% → 20% |
| `research/rr-study.mjs`, `rr-portfolio.mjs` | R:R cố định & SL nhỏ có tạo lợi thế? | SL nhỏ tệ hơn đồng xu; breakout + SL 2 ATR + 1:3 có lợi thế; ghép với R3 ~31%/năm, sụt ~38% |
| `_sbx/parity.mjs`, `parity-log.mjs`, `fwd-expect.mjs` | Engine của swing bot có khớp nghiên cứu? Kỳ vọng forward | Khớp từng năm; Breakout hơn rổ +0.6%/5 ngày, R3 ≈ 0 |
| `_sbx/mock-binance.mjs`, `integration.sh`, `e2e-live.sh`, `smoke.sh` | Test tích hợp bot với Binance giả (REST + WebSocket, 418) và thật | Đạt |
| `_sbx/ws-probe.mjs`, `gap-test.mjs`, `reconnect-test.mjs`, `explain-signal.mjs` | Tái hiện lỗi WebSocket của bot EMA cũ; giải thích 1 tín hiệu | Đã sửa trong `src/` |

Lưu ý: dữ liệu chỉ gồm coin còn niêm yết (survivorship bias); quá khứ không bảo đảm tương lai.
