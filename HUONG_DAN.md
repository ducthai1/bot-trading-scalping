# Hướng dẫn vận hành & bảo trì

Tài liệu này dành cho người chạy và bảo trì repo về lâu dài: cài đặt, **biến môi trường**, **cơ chế hoạt động**,
đọc dashboard, đánh giá đợt chạy thử, bảo trì và xử lý sự cố.

## Mục lục
1. [Repo có gì](#1-repo-có-gì)
2. [Cài đặt nhanh (Linux / macOS)](#2-cài-đặt-nhanh-linux--macos)
3. [Biến môi trường — checklist đủ tính năng](#3-biến-môi-trường--checklist-đủ-tính-năng)
4. [Cơ chế swing bot](#4-cơ-chế-swing-bot)
5. [Dữ liệu & file](#5-dữ-liệu--file)
6. [Dashboard & API](#6-dashboard--api)
7. [Tin nhắn Telegram & việc bạn cần làm](#7-tin-nhắn-telegram--việc-bạn-cần-làm)
8. [Đợt chạy thử 3–6 tuần: đánh giá thế nào](#8-đợt-chạy-thử-36-tuần-đánh-giá-thế-nào)
9. [Bảo trì thường gặp](#9-bảo-trì-thường-gặp)
10. [Xử lý sự cố](#10-xử-lý-sự-cố)
11. [Cấu trúc code & quy tắc khi sửa](#11-cấu-trúc-code--quy-tắc-khi-sửa)
12. [Bot EMA scalping (src/)](#12-bot-ema-scalping-src)
13. [Giới hạn cần biết](#13-giới-hạn-cần-biết)

---

## 1. Repo có gì

| | **Swing bot** (`swing/`) — dùng chính | **Bot EMA scalping** (`src/`) — cũ |
|---|---|---|
| Thị trường | Binance **spot**, 34 coin không phải meme | Binance futures, BTCUSDT |
| Khung | Nến **ngày** (giữ lệnh vài ngày) | 3m / 5m |
| Chiến lược | **R3** (Connors) + **Breakout 20 ngày** (Turtle) | EMA 8/13/21 ribbon pullback |
| Backtest | ~30%/năm, sụt vốn tối đa ~40% (2020–2026) | Không có lợi thế sau phí (xem mục 12) |
| Đặt lệnh | **Không** — chỉ cảnh báo + sổ giả lập | Không — chỉ cảnh báo |
| Chạy | `pm2 start ecosystem.config.cjs --only swing-bot` | `--only btc-scalping-bot` |

Cả hai bot **không dùng API key Binance** và **không bao giờ tự đặt lệnh**: chúng chỉ đọc dữ liệu thị trường công khai.

---

## 2. Cài đặt nhanh (Linux / macOS)

**Yêu cầu:** Node.js ≥ 20, git, pm2. Không cần quyền root cho bot.

```bash
# 1) Node 20+ (chọn 1 cách)
#    macOS:  brew install node
#    Linux:  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install 22
node -v                                  # phải >= v20

# 2) Lấy code (đặt ở thư mục cố định, KHÔNG để trong thư mục tạm)
git clone git@github.com:ducthai1/bot-trading-scalping.git ~/bots/bot-trading-scalping
cd ~/bots/bot-trading-scalping
npm ci                                   # cài ws + pm2 (theo package-lock)
npm i -g pm2                             # pm2 dùng toàn hệ thống (khuyên dùng)

# 3) Biến môi trường (mục 3)
cp .env.example .env && nano .env

# 4) Chạy thử 1 lần, không gửi Telegram — phải thấy "✅ Job ngày ..."
npm run swing:once

# 5) Chạy nền 24/7, tự bật lại khi khởi động máy
pm2 start ecosystem.config.cjs --only swing-bot
pm2 save
pm2 startup                              # làm theo lệnh nó in ra (Linux: sudo ...; macOS: launchd)
pm2 install pm2-logrotate                # tránh log pm2 phình to
```

Mở dashboard: **http://127.0.0.1:3100**. Kiểm tra sức khoẻ: `curl http://127.0.0.1:3100/health`.

> **macOS / laptop:** khi máy ngủ, bot cũng ngủ. Lúc thức dậy bot tự **chạy bù** (mục 4.4), nhưng cảnh báo sẽ đến trễ.
> Để chạy thử nghiêm túc nên dùng máy luôn bật (mini PC / VPS Linux) hoặc tắt chế độ ngủ khi cắm sạc.

---

## 3. Biến môi trường — checklist đủ tính năng

Tất cả đặt trong file **`.env` ở thư mục gốc repo** (mẫu đầy đủ, có chú thích: `.env.example`). Swing bot tự đọc
`.env` (không cần cờ Node), đọc cả `swing/.env` nếu có. Biến đặt sẵn trong môi trường hệ thống được ưu tiên hơn file.

### Checklist (swing bot)
- [ ] `TELEGRAM_TOKEN` + `TELEGRAM_CHAT_ID` → nhận cảnh báo mua/bán, SL/TP, báo cáo tuần, báo lỗi
- [ ] `SWING_ADMIN_KEY` (hoặc `ADMIN_KEY`) → các nút trên dashboard: chạy job, test Telegram, reset cầu dao
- [ ] Vốn ≥ 65$ (`swing/config.json` → `capital`, hoặc `SWING_CAPITAL`) → nếu thấp hơn, **mọi lệnh bị bỏ qua**
- [ ] Bấm **Test Telegram** trên dashboard (nhập admin key) → nhận được tin "✅ Test từ dashboard"

### Bảng đầy đủ

| Biến | Bot | Bắt buộc? | Mặc định | Tác dụng / thiếu thì sao |
|---|---|---|---|---|
| `TELEGRAM_TOKEN` | cả 2 | **Có** (để có cảnh báo) | – | Token bot Telegram. Thiếu → không gửi tin, chỉ log + dashboard |
| `TELEGRAM_CHAT_ID` | cả 2 | **Có** | – | Chat/nhóm nhận tin. Thiếu → như trên |
| `ADMIN_KEY` | cả 2 | Nên có | – | Khoá các nút thao tác dashboard. Thiếu → nút bị tắt (an toàn) |
| `SWING_ADMIN_KEY` | swing | Không | = `ADMIN_KEY` | Key riêng cho dashboard swing |
| `SWING_TELEGRAM_TOKEN` | swing | Không | = `TELEGRAM_TOKEN` | Gửi cảnh báo swing sang bot Telegram khác |
| `SWING_TELEGRAM_CHAT_ID` | swing | Không | = `TELEGRAM_CHAT_ID` | Gửi sang nhóm khác |
| `SWING_CAPITAL` | swing | Không | `config.json` (100) | Vốn sổ giả lập. Chỉ áp dụng khi tạo sổ mới |
| `SWING_HOST` | swing | Không | `127.0.0.1` | `0.0.0.0` để xem dashboard từ máy khác |
| `SWING_PORT` | swing | Không | `3100` | Cổng dashboard |
| `SWING_DATA_DIR` | swing | Không | `swing/data` | Nơi lưu sổ/lịch sử. Nên đặt ngoài repo |
| `SWING_BINANCE_BASE` | swing | Không | `https://data-api.binance.vision` | Chỉ đổi khi test với máy chủ giả |
| `SWING_WS_BASE` | swing | Không | `wss://data-stream.binance.vision` | Như trên, cho WebSocket |
| `PORT` | EMA | Không | `3000` | Cổng web bot EMA (Render tự cấp) |
| `APP_URL` | EMA | Không | `RENDER_EXTERNAL_URL` | URL để bot EMA tự ping giữ thức |
| `RENDER_EXTERNAL_URL` | EMA | Không | do Render cấp | Không cần tự đặt |
| `BINANCE_SOURCE` | EMA | Không | `futures` | Nguồn REST: `futures`, `spot` hoặc `futures,spot` |
| `BINANCE_TIMEOUT_MS` | EMA | Không | `10000` | Timeout request REST |

### Lấy Telegram token & chat id
1. Trong Telegram, chat với **@BotFather** → `/newbot` → đặt tên → nhận **token** dạng `123456789:ABC...` → `TELEGRAM_TOKEN`.
2. Nhắn một tin bất kỳ cho bot vừa tạo (hoặc thêm bot vào nhóm rồi nhắn trong nhóm).
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` → tìm `"chat":{"id": ...}` → `TELEGRAM_CHAT_ID`
   (nhóm có id âm, ví dụ `-100123...`).
4. Kiểm tra: dashboard → nhập admin key → **Test Telegram**.

### Cấu hình chiến lược (không phải env)
Thông số chiến lược nằm trong `swing/config.json`. **Đừng sửa file này trực tiếp** — tạo `swing/config.local.json`
(git bỏ qua) chỉ chứa phần muốn đổi, ví dụ `{ "capital": 150 }`. Bot gộp `config.json` ← `config.local.json` ← biến `SWING_*`.

---

## 4. Cơ chế swing bot

### 4.1 Hai chiến lược (đúng luật trong sách, không tối ưu tham số)

| | **R3** (Connors & Alvarez, *High Probability ETF Trading*) | **Breakout** (Turtle, cửa sổ 20 ngày) |
|---|---|---|
| Ý tưởng | Mua coin khoẻ bị bán tháo 3 ngày, bán khi bật lại | Mua khi giá phá đỉnh 20 ngày, để lời chạy |
| Mua | Giá đóng cửa > SMA200, RSI(2) giảm 3 ngày liền (bắt đầu < 60), hôm nay < 10 | Giá đóng cửa > đỉnh cao nhất 20 ngày trước |
| Bán | Mở cửa hôm sau khi RSI(2) > 70 | SL = giá vào − 2×ATR(14); TP = giá vào + 3×SL; hoặc sau 60 ngày |
| Cắt lỗ | **Không** (đúng sách; backtest cho thấy cắt lỗ làm hỏng R3) | Có (SL) |
| Backtest | thắng 68.7%, +2.33%/lệnh | chạm TP 34.6%, +0.42R/lệnh |

**Bộ lọc & quản lý vốn chung**
- Chỉ mở lệnh mới khi **BTC > SMA200** (thị trường chung đang tăng).
- Mỗi chiến lược tối đa **6 lệnh** cùng lúc và **2 lệnh mới/ngày** (ngày sập, hàng chục coin cùng báo — thực chất là một ván cược).
- Mỗi lệnh = **vốn hiện tại / 12**, khối lượng làm tròn xuống theo bước lot của Binance, phải ≥ 5$.
- Nhiều tín hiệu cùng ngày: R3 ưu tiên RSI(2) thấp nhất; Breakout ưu tiên coin ít biến động (ATR% thấp).
- **Cầu dao:** sụt vốn từ đỉnh ≥ 50% → ngừng mở lệnh mới (lệnh cũ vẫn được quản lý) cho tới khi reset thủ công.
- Một coin có thể đang được giữ ở **cả hai** chiến lược cùng lúc (hai lệnh độc lập).

### 4.2 Một ngày của bot (giờ Việt Nam)

| Thời điểm | Việc bot làm |
|---|---|
| **07:02** (00:02 UTC) | **Job ngày**: lấy nến ngày (REST) → chốt ngày hôm qua (tín hiệu mới, tính vốn, cầu dao) → mở cửa hôm nay (bán/mua) → Telegram |
| Liên tục | **Realtime** (WebSocket): mỗi nến 1 phút đóng → cập nhật SL/TP + lãi/lỗ tạm của mọi lệnh thật và lệnh giả định |
| Mỗi giờ | **Gap-fill**: lấy bù qua REST những phút WebSocket bị lỡ (0 request khi socket ổn định) |
| Thứ Hai 07:02 | Thêm **báo cáo tuần** |

### 4.3 Thứ tự xử lý (quan trọng khi sửa code)
Engine (`swing/src/engine.js`) luôn xử lý mỗi ngày theo đúng thứ tự, **giống hệt backtest**:

```
openDay(d)   bán các lệnh đã có tín hiệu thoát hôm trước → mua theo thứ tự ưu tiên (giá mở cửa)
intraday(d)  nến trong ngày (1m realtime / 1m-1h REST / 4h trong backtest): SL/TP, MFE/MAE
closeDay(d)  hết hạn 60 ngày, tín hiệu thoát R3, tính vốn cuối ngày, cầu dao, tín hiệu mới cho ngày mai
```
- Nến realtime của ngày **chưa được mở** (00:00–00:02) phải xếp hàng chờ job ngày.
- Nếu phát hiện **thiếu phút** trước một nến mới, bot lấy bù qua REST rồi mới xử lý → không bao giờ bỏ sót SL.
- Mỗi lệnh nhớ thời điểm kết thúc nến cuối đã xử lý (`lastBarEnd`) → chạy lại cùng dữ liệu không tạo trùng; trộn nến 1m/1h an toàn.
- Nếu SL và TP cùng nằm trong một nến → **tính SL trước** (giả định bất lợi).

### 4.4 Giá thực thi trong sổ giả lập
| Tình huống | Bán | Mua |
|---|---|---|
| Job chạy đúng giờ (≤ 30 phút sau 07:00) | Giá mở cửa ngày | Giá mở cửa ngày |
| Trễ ≤ 8 giờ (ví dụ máy vừa bật) | Giá hiện tại (ghi "trễ") | Giá hiện tại (ghi "trễ") |
| Trễ > 8 giờ | Giá hiện tại | **Bỏ qua** (tín hiệu cũ, không mua đuổi) |
| **Chạy bù** các ngày máy tắt | Giá mở cửa ngày đó + nhắc bạn bán ngay | **Bỏ qua** |

Backtest cho thấy vào lệnh trễ 12 giờ mất ~1/3 lợi nhuận, trễ 1 ngày mất một nửa — nên **làm trong buổi sáng**.

### 4.5 Sổ giả lập, lệnh giả định và hai cách kiểm chứng
- **Sổ giả lập** (`state.positions`, `trades.jsonl`): danh mục bot *sẽ* nắm nếu bạn làm đúng mọi cảnh báo — dùng để so với backtest.
- **Lệnh giả định (shadow)**: **mỗi** tín hiệu — kể cả bị bỏ qua vì đủ lệnh, lọc BTC, cầu dao — được theo dõi như một lệnh
  không giới hạn vốn với cùng luật thoát. Dùng để biết **chỉ báo đúng hay sai**, độc lập với chuyện có vào lệnh hay không.
- **Kiểm chứng 1 — đúng/sai:** lệnh giả định có lãi sau phí → ĐÚNG.
- **Kiểm chứng 2 — so với rổ:** lợi nhuận giá đóng cửa sau 1/3/5/10 ngày của coin có tín hiệu, trừ trung bình rổ 34 coin cùng kỳ.
  Dương = coin chạy hơn thị trường.
  - Backtest: **Breakout hơn rổ rõ rệt** (+0.6% sau 5 ngày). **R3 ≈ 0** — R3 không chọn được coin mạnh hơn; nó kiếm tiền nhờ
    mua lúc *cả thị trường* giảm và bán khi hồi. R3 không hơn rổ là **bình thường**, không phải lỗi.
- **MFE / MAE**: lãi tạm cao nhất / lỗ tạm sâu nhất trong lúc giữ — dữ liệu để tối ưu SL/TP sau này.

### 4.6 Chống ban IP & độ bền
- REST dùng `data-api.binance.vision` (máy chủ chỉ dữ liệu thị trường), mọi request **xếp hàng, cách nhau ≥ 250ms**.
  Một ngày chỉ ~40 request REST khi WebSocket ổn định.
- Gặp **418/429**: dừng **mọi** request tới hạn `Retry-After`, ghi hạn vào `net.json` → **khởi động lại cũng không gọi lại sớm**.
- WebSocket `data-stream.binance.vision` (1 kết nối, 68 luồng, không tính hạn mức REST): watchdog 60s, kết nối lại giãn dần
  1s → 60s có nhiễu ngẫu nhiên, xử lý việc Binance tự ngắt sau 24h.
- Dùng **giờ máy chủ Binance** cho job ngày; cảnh báo nếu đồng hồ máy lệch > 1 phút.
- Thiếu dữ liệu > 20% coin (hoặc thiếu BTC) → **không chốt ngày**, thử lại sau (tránh mất tín hiệu vĩnh viễn).
- Job lỗi giữa chừng → sổ được **khôi phục nguyên trạng** từ bản chụp trước job.
- Ghi file **nguyên tử** (ghi tạm → fsync → đổi tên) + bản `.bak`; file JSONL chịu được dòng cuối bị cắt khi mất điện.
- **File khoá** `bot.lock` ngăn 2 bản cùng ghi một thư mục dữ liệu; khoá của tiến trình đã chết được thu hồi tự động.
- Telegram lỗi không bao giờ làm dừng bot (thử lại 3 lần, chia tin dài).

---

## 5. Dữ liệu & file

Thư mục dữ liệu: `swing/data` (hoặc `SWING_DATA_DIR`). **Sao lưu thư mục này** = sao lưu toàn bộ lịch sử thử nghiệm.

| File | Nội dung |
|---|---|
| `state.json` (+ `.bak`) | Sổ hiện tại: tiền, lệnh mở, lệnh chờ, lệnh giả định, chỉ số rổ, ngày đã chốt |
| `trades.jsonl` | Lệnh đã đóng (giá vào/ra, phí, lãi %, R, số ngày, lý do thoát, MFE/MAE, trễ?) |
| `orders.jsonl` | Lệnh mua đã ghi (kèm SL/TP) |
| `signals.jsonl` | Sổ tín hiệu: `signal` (chỉ báo) → `signal_update` (vào lệnh / bỏ qua + lý do) → `signal_result` (đúng/sai) → `signal_forward` (sau N ngày so với rổ) |
| `equity.jsonl` | Vốn cuối mỗi ngày, sụt vốn |
| `events.jsonl` | Nhật ký (log dễ đọc, lỗi, cảnh báo); tự xoay vòng khi > 5MB |
| `daily-cache.json` | Nến ngày gần nhất cho bảng "nếu đóng cửa bây giờ" |
| `net.json` | Hạn chặn của Binance nếu từng bị 418/429 |
| `bot.lock` | Khoá tiến trình (tự xoá khi bot dừng) |
| `cache/` | Dữ liệu lịch sử của lệnh backtest |

Xuất CSV (mở bằng Excel/Google Sheets): `/api/trades.csv`, `/api/signals.csv`, `/api/equity.csv`.

---

## 6. Dashboard & API

`http://127.0.0.1:3100` — tự làm mới: số liệu realtime mỗi 5 giây, bảng báo cáo mỗi 60 giây.

| Tab | Xem gì |
|---|---|
| **Tổng quan** | Vốn & lãi/lỗ realtime, sụt vốn, cầu dao, BTC > SMA200, việc cần làm, **giá realtime & tín hiệu dự kiến**, lệnh đang mở (cách SL/TP), so với backtest, đường vốn |
| **Lịch sử lệnh** | Lọc theo chiến lược / tháng / lãi-lỗ; MFE/MAE; tổng |
| **Theo giai đoạn** | Tháng, năm, từng chiến lược (thắng %, kỳ vọng, PF, R, giữ TB) |
| **Tín hiệu đúng / sai** | Độ chính xác theo chiến lược / theo quyết định (vào lệnh vs từng lý do bỏ qua) / theo tháng; sổ tín hiệu chi tiết |
| **Kiểm chứng & đánh giá** | Kết luận tạm; đúng % so với backtest (khoảng tin cậy 95%); lợi nhuận sau N ngày so với rổ |
| **Nhật ký** | Log hệ thống, lệnh mua đã ghi |

Nút trên header (cần admin key): **Chạy job đến hạn**, **Test Telegram**, **Reset cầu dao**.

| API | Mô tả |
|---|---|
| `GET /health` | `ok`, job đang chạy, lần chạy thành công gần nhất, lỗi gần nhất (dùng cho giám sát) |
| `GET /api/live` | Realtime: trạng thái WebSocket, vốn, lệnh mở, bảng tín hiệu dự kiến |
| `GET /api/report` | Toàn bộ báo cáo |
| `GET /api/*.csv` | Xuất dữ liệu |
| `POST /api/admin/run` · `reset-breaker` · `test-telegram` | Cần header `x-admin-key` |

> Mặc định chỉ mở trên `127.0.0.1`. Nếu đặt `SWING_HOST=0.0.0.0`, ai vào được mạng của bạn sẽ xem được dashboard (chỉ đọc);
> các nút vẫn cần admin key.

---

## 7. Tin nhắn Telegram & việc bạn cần làm

| Tin | Khi nào | Bạn làm gì (trên Binance **spot**, không đòn bẩy) |
|---|---|---|
| 📅 **Tin hằng ngày** | 07:02 | 🔴 **BÁN**: lệnh Market đúng khối lượng ghi trong tin. 🟢 **MUA**: lệnh Market khoảng số $ ghi trong tin |
| ↳ MUA Breakout | kèm SL/TP | Đặt ngay lệnh **OCO** (bán chốt lời TP + dừng lỗ SL) |
| ↳ MUA R3 | không có SL | Chờ bot báo BÁN (RSI(2) > 70) |
| ↳ BÁN Breakout "quá 60 ngày" | | **Huỷ OCO trước** rồi mới bán |
| ⚡ **Breakout chạm SL/TP** | ngay khi xảy ra | Kiểm tra OCO đã khớp (không cần làm gì nếu đã đặt OCO) |
| ⚠️ **Chạy bù** | sau khi máy tắt/ngủ | Bán ngay các lệnh BÁN được liệt kê nếu đang giữ; lệnh MUA cũ đã bị bỏ |
| ⛔ **Cầu dao** | sụt ≥ 50% | Dừng lại, xem tab Kiểm chứng, quyết định có reset không |
| 🗓 **Báo cáo tuần** | thứ Hai | Đọc kết luận tạm |
| ❌ **Bot lỗi** | job lỗi (tối đa 1 tin / 6 giờ) | Thường tự hết; nếu kéo dài xem mục 10 |

---

## 8. Đợt chạy thử 3–6 tuần: đánh giá thế nào

**Mục tiêu:** xác nhận với dữ liệu thật rằng chỉ báo hoạt động như backtest, **trước khi dùng tiền thật**.

1. Chạy bot với sổ giả lập (mặc định 100$). Telegram vẫn báo — bạn có thể bỏ qua, hoặc làm tay song song để kiểm tra giá khớp thật.
2. Mỗi tuần xem tab **Kiểm chứng & đánh giá** (hoặc báo cáo tuần trên Telegram).
3. **Đừng đánh giá bằng vài lệnh thật** (~4–5 lệnh/chiến lược/tháng — quá ít). Hãy nhìn **sổ tín hiệu**: backtest ~12 tín hiệu R3
   và ~50 tín hiệu Breakout mỗi tháng (tuỳ thị trường; khi BTC < SMA200 bot vẫn ghi tín hiệu giả định).
4. Bot chỉ kết luận khi mỗi chiến lược có **≥ 20 tín hiệu có kết quả** (Breakout thường 3–4 tuần, R3 có thể 6–8 tuần).

| Chỉ số | Backtest | Đọc kết quả |
|---|---|---|
| R3 — tín hiệu đúng | 72.7% | Khoảng tin cậy 95% chứa 72.7% → phù hợp |
| Breakout — tín hiệu đúng | 36.3% | Như trên |
| Breakout — hơn rổ sau 5 ngày | +0.59% | Nên dương; âm kéo dài là dấu hiệu xấu |
| R3 — hơn rổ sau 5 ngày | +0.22% (≈ 0) | Quanh 0 là **bình thường** |
| R3 — thắng / lãi TB mỗi lệnh thật | 68.7% / +2.33% | Chỉ tham khảo khi đủ lệnh |
| Breakout — chạm TP / R TB | 34.6% / +0.42R | Như trên |

**Khi nào KHÔNG nên dùng tiền thật:** dashboard báo "⚠️ Kém hơn backtest rõ rệt"; tỉ lệ đúng nằm hẳn dưới khoảng kỳ vọng;
Breakout hơn rổ âm liên tục; hoặc có lỗi vận hành lặp lại (tab Nhật ký).
**Khi chuyển sang tiền thật:** dừng bot, sao lưu rồi xoá thư mục dữ liệu, đặt `capital` = số vốn thật, chạy lại → sổ mới
khớp với tài khoản của bạn.

---

## 9. Bảo trì thường gặp

```bash
pm2 status                       # bot có đang chạy
pm2 logs swing-bot --lines 200   # log realtime (cùng nội dung tab Nhật ký)
pm2 restart swing-bot            # khởi động lại (an toàn: sổ được giữ, tự chạy bù)
pm2 stop swing-bot               # dừng
npm run test:swing               # chạy toàn bộ test của swing bot
```

| Việc | Cách làm |
|---|---|
| **Cập nhật code** | `git pull && npm ci && npm run test:swing && pm2 restart swing-bot` |
| **Đổi vốn / bắt đầu sổ mới** | `pm2 stop swing-bot` → sao lưu & xoá thư mục dữ liệu → sửa `capital` trong `config.local.json` → `pm2 start ...` |
| **Sao lưu** | Copy thư mục dữ liệu (có thể copy khi bot đang chạy; `state.json.bak` là bản dự phòng) |
| **Chuyển sang máy khác** | Dừng bot máy cũ → copy thư mục dữ liệu sang → chạy máy mới (bot tự chạy bù các ngày ở giữa) |
| **Thêm / bớt coin** | Sửa `coins` trong `config.local.json`. Chỉ thêm coin không phải meme, có ≥ 1 năm dữ liệu spot. Nên chạy backtest lại |
| **Đổi tham số chiến lược** | Sửa trong `config.local.json` → **bắt buộc** chạy `npm run swing:backtest` và cập nhật `expectations` cho khớp — nếu không, mục "so với backtest" sẽ so sai |
| **Chạy backtest** | `npm run swing:backtest -- --from 2020-01-01` (lần đầu ~800 request REST, ~4 phút, có cache; chạy cùng engine với bot) |
| **Reset cầu dao** | Dashboard → nhập admin key → Reset cầu dao (đỉnh vốn được đặt lại = vốn hiện tại) |
| **Telegram mới** | Sửa `.env` → `pm2 restart swing-bot` → Test Telegram |
| **Giới hạn log pm2** | `pm2 install pm2-logrotate` (mặc định giữ 10MB/30 file) |

---

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Log `❌ Job daily lỗi: Binance 418/429` | IP bị Binance giới hạn (thường do chương trình khác cùng IP) | Bot tự chờ hết hạn và thử lại; **đừng** restart liên tục. Kiểm tra chương trình khác dùng Binance trên cùng mạng |
| `Binance đang chặn tạm thời tới ...` sau khi restart | Đang trong hạn chặn (lưu ở `net.json`) | Chờ; hoặc xoá `net.json` nếu chắc chắn đã hết |
| Badge **Realtime** không xanh | Mạng chập chờn / máy vừa ngủ dậy | Tự kết nối lại (≤ 60s); phút bị mất được gap-fill lấy bù |
| `Đã có một bot swing khác đang chạy` | Có 2 bản cùng chạy, hoặc khoá của tiến trình cũ | `pm2 status` / `ps aux \| grep swing`; tắt bản thừa. Khoá của tiến trình đã chết tự được thu hồi |
| `Đồng hồ máy lệch ...` | Giờ hệ thống sai | Bật NTP: Linux `sudo timedatectl set-ntp true`; macOS: Cài đặt → Ngày & giờ → tự động |
| Không nhận Telegram | Token/chat id sai, chưa nhắn bot lần nào, đang chạy `--dry` | Test Telegram trên dashboard; xem lỗi trong Nhật ký |
| Dashboard không mở | Sai cổng / cổng bận / bot không chạy | `curl 127.0.0.1:3100/health`; đổi `SWING_PORT` |
| `X: không tải được nến ngày` | Coin bị huỷ niêm yết / đổi tên | Xoá coin khỏi `coins` |
| `Thiếu dữ liệu .../34 coin — chưa chốt ngày` | Mạng lỗi lúc 07:02 | Bot tự thử lại mỗi 10 phút |
| Mọi tín hiệu "Dưới lệnh tối thiểu" | Vốn quá nhỏ (vốn/12 < 5$) | Tăng vốn ≥ 65$ (sổ mới) |
| Không có tín hiệu nhiều ngày | Bình thường — thị trường không có setup, hoặc BTC < SMA200 | Xem bảng "tín hiệu dự kiến" và tab Tín hiệu |
| `state.json hỏng ..., thử bản .bak` | Mất điện đúng lúc ghi | Bot tự dùng `.bak`; kiểm tra lại số liệu ngày gần nhất |

---

## 11. Cấu trúc code & quy tắc khi sửa

```
swing/
  config.json          tham số chiến lược + kỳ vọng backtest (config.local.json để ghi đè)
  src/
    main.js            điều phối: lịch, job ngày, realtime, gap-fill, vòng đời tiến trình
    engine.js          ★ logic giao dịch THUẦN (openDay / intraday / closeDay) — dùng chung bot & backtest
    strategy.js        luật R3 / Breakout trên nến đã đóng
    indicators.js      SMA, RSI Wilder, ATR (giống hệt bản nghiên cứu)
    sim.js             chạy lại lịch sử bằng engine (backtest)
    backtest.js        CLI backtest có cache
    live.js            WebSocket giá realtime
    binance.js         REST: xếp hàng, chống ban, retry
    store.js           ghi file nguyên tử, JSONL, khoá tiến trình
    history.js         ghi/đọc bảng lịch sử (chống trùng)
    report.js          thống kê, khoảng tin cậy, kiểm chứng, đánh giá
    watch.js           bảng "nếu đóng cửa bây giờ"
    notify.js          nội dung Telegram + dòng log dễ đọc
    schedule.js        lịch theo đồng hồ thật
    server.js, ui.html dashboard + API
    config.js, labels.js, telegram.js, util.js
  test/                node:test — 25 test (engine, realtime, lưu trữ, lịch, báo cáo, mô phỏng)
```

**Quy tắc vàng khi sửa:**
1. Mọi thay đổi **luật giao dịch** chỉ làm trong `engine.js` / `strategy.js` (hàm thuần, không I/O). Bot và backtest dùng chung →
   sửa xong **phải** chạy backtest để thấy ảnh hưởng.
2. Không gọi REST trong vòng lặp theo phút/giây. Dữ liệu realtime đi qua WebSocket; REST chỉ để chốt ngày và lấy bù.
3. Giữ thứ tự `openDay → intraday → closeDay`; mọi xử lý phải **idempotent** (chạy lại không tạo trùng).
4. Sự kiện mới phải có `id` ổn định để `history.js` khử trùng khi ngày bị xử lý lại.
5. Chạy `npm run test:swing` trước khi commit; thêm test cho hành vi mới.
6. Tránh "học thuộc" dữ liệu: đổi tham số dựa trên kết quả backtest dễ cho số đẹp mà không thật. Ưu tiên giữ luật gốc.

---

## 12. Bot EMA scalping (src/)

Đợt review đã sửa các lỗi vận hành của bot cũ: WebSocket có backoff + watchdog + vá nến thiếu; không trộn giá spot vào futures;
gộp đánh giá khi nhiều khung đóng cùng lúc; Telegram lỗi không làm sập bot; endpoint `/api/scan`, `/test-tele` cần `ADMIN_KEY`;
Dockerfile cài dependency; thêm bộ lọc R:R sau phí và cooldown 30 phút.

**Kết luận nghiên cứu:** chiến lược EMA ribbon scalping (cả bản md lẫn bản Lockwood gốc, khung 3m/5m/4h/ngày, futures hay spot)
**không có lợi thế sau phí** trên dữ liệu 2020–2026. Chỉ nên chạy để quan sát, không dùng tiền thật.

**Deploy Render:** nếu Render tự deploy từ nhánh chính, khi merge các thay đổi này cần đặt biến `ADMIN_KEY` trên Render
(nếu không, nút Quét/Test trên dashboard sẽ tắt — đó là chủ đích bảo mật).

---

## 13. Giới hạn cần biết

- Kết quả backtest dùng **34 coin còn sống tới nay** (không có LUNA, FTT…) nên có phần đẹp hơn thực tế.
- **Quá khứ không bảo đảm tương lai.** 2020–2021 đóng góp phần lớn lợi nhuận; R3 không có cắt lỗ (lệnh tệ nhất −46%).
- Sổ giả lập giả định khớp lệnh ở giá mở cửa/giá TP với phí 0.1% và trượt giá ước lượng; lệnh thật của bạn có thể lệch.
- Bot **không** biết bạn có thực sự đặt lệnh hay không — sổ giả lập là "nếu làm đúng mọi cảnh báo".
- Với 100$, kỳ vọng chỉ khoảng vài chục cent mỗi tuần; mục đích của đợt này là **kiểm chứng hệ thống**, không phải kiếm thu nhập.
  Không dùng đòn bẩy.
