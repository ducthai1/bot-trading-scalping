// Live bot: every minute (+closeDelayMs) evaluate the trigger TFs whose candle just closed.
import http from 'node:http';
import { loadConfig, checkNotional } from './config.js';
import { fetchKlines } from './binance.js';
import { evaluate, trendOf } from './strategy.js';
import { formatAlert } from './format.js';
import { sendTelegram } from './telegram.js';

const dry = process.argv.includes('--dry');
const cfg = loadConfig();
const sent = new Set();
const ts = (ms) => new Date(ms).toLocaleString('vi-VN', { hour12: false });

// Thống kê hoạt động & trạng thái thị trường của bot
const stats = {
  startTime: new Date(),
  lastCheckTime: null,
  lastCheckSummary: 'Đang khởi động...',
  alertsSentCount: 0,
  market: {
    btcPrice: 0,
    trend1h: 'none',
    trend15m: 'none',
    statusText: 'Đang khởi động dữ liệu...',
    isSynced: false,
    expectedSide: null,
    tfs: {},
  },
  recentLogs: [],
};

checkNotional(cfg);
if (!dry && (!cfg.telegram.token || !cfg.telegram.chatId)) {
  console.error('Thiếu Telegram token/chatId (config.json hoặc env TELEGRAM_TOKEN, TELEGRAM_CHAT_ID). Chạy thử: npm run dry');
  process.exit(1);
}

// Mở HTTP server healthcheck & Web Dashboard khi chạy trên Render / VPS (process.env.PORT)
const port = process.env.PORT;
if (port) {
  http
    .createServer((req, res) => {
      const host = req.headers.host || `localhost:${port}`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${host}`;
      const url = new URL(req.url, origin);

      // Endpoint API status cho UptimeRobot / cron-job / frontend polling
      if (url.pathname === '/ping' || url.pathname === '/health' || url.pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(
          JSON.stringify({
            status: 'ok',
            service: 'btc-ema-ribbon-alert',
            uptimeMin: Math.floor(process.uptime() / 60),
            lastCheck: stats.lastCheckTime ? ts(stats.lastCheckTime.getTime()) : null,
            lastSummary: stats.lastCheckSummary,
            alertsSent: stats.alertsSentCount,
            dryRun: dry,
            market: stats.market,
            recentLogs: stats.recentLogs,
          })
        );
      }

      // Endpoint kích hoạt quét nến thủ công ngay lập tức
      if (url.pathname === '/api/scan') {
        tick(true)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: true,
                message: 'Quét thị trường thành công!',
                market: stats.market,
                recentLogs: stats.recentLogs,
              })
            );
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }

      // Endpoint kiểm tra gửi tin nhắn Telegram mẫu tín hiệu Alert chuẩn
      if (url.pathname === '/test-tele') {
        if (!cfg.telegram.token || !cfg.telegram.chatId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(
            JSON.stringify({
              ok: false,
              error: 'Chưa cấu hình TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID trên Render.',
            })
          );
        }

        const side = (url.searchParams.get('side') || 'LONG').toUpperCase();
        const sampleSignal = side === 'SHORT'
          ? {
              side: 'SHORT',
              tf: '5m',
              htfTrend: 'Downtrend',
              touchedEma: 21,
              pbCount: 7,
              color: 'Đỏ',
              entry: 98450.0,
              sl: 98468.0,
              tp1: 98380.0,
              tp2: 98320.0,
            }
          : {
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

        const alertText = formatAlert(sampleSignal, cfg);

        sendTelegram(cfg.telegram.token, cfg.telegram.chatId, alertText)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(
              JSON.stringify({
                ok: true,
                message: `Đã bắn tín hiệu mẫu [${sampleSignal.side}] vào Telegram!`,
                preview: alertText,
              })
            );
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }

      // Giao diện web trực quan khi truy cập trực tiếp bằng trình duyệt
      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BTC EMA Ribbon Scalping Bot - Dashboard</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #151d2f;
      --border: #243048;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --up: #10b981;
      --down: #ef4444;
      --chop: #f59e0b;
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 20px 12px;
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 860px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--card-bg);
      border-radius: 14px;
      padding: 20px;
      border: 1px solid var(--border);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #064e3b;
      color: #34d399;
      padding: 6px 14px;
      border-radius: 999px;
      font-weight: 600;
      font-size: 13px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    h1 { font-size: 22px; margin: 0 0 6px 0; display: flex; align-items: center; gap: 8px; }
    p { margin: 4px 0; color: var(--text-muted); font-size: 14px; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .metric-box {
      background: #0d1322;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .metric-title { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 4px; }
    .metric-val { font-size: 18px; font-weight: 700; color: #f8fafc; }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
    }
    .badge-up { background: #064e3b; color: #34d399; }
    .badge-down { background: #450a0a; color: #f87171; }
    .badge-chop { background: #451a03; color: #fbbf24; }
    .badge-none { background: #1e293b; color: #94a3b8; }

    /* Logic Explanation Box */
    .market-status-box {
      margin-top: 14px;
      padding: 14px;
      background: #101828;
      border-radius: 8px;
      border-left: 4px solid var(--blue);
    }
    .status-headline {
      font-size: 15px;
      font-weight: 600;
      color: #e2e8f0;
      margin-bottom: 6px;
    }
    .status-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }

    /* 5 Rules Cheat Sheet */
    .rules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .rule-item {
      background: #0d1322;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .rule-item b { color: #38bdf8; font-size: 13px; }
    .rule-item p { margin: 4px 0 0 0; font-size: 12px; color: #94a3b8; line-height: 1.4; }

    /* Action buttons */
    .btn-group { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .btn {
      border: none;
      padding: 10px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .btn-scan { background: var(--blue); color: white; }
    .btn-long { background: var(--up); color: white; }
    .btn-short { background: var(--down); color: white; }

    /* Live Logs Table */
    .table-container {
      margin-top: 14px;
      overflow-x: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }
    th {
      background: #0d1322;
      padding: 10px 12px;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      color: #cbd5e1;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }
    .log-signal { background: rgba(16, 185, 129, 0.1); color: #34d399; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .log-nosignal { background: rgba(245, 158, 11, 0.1); color: #fbbf24; padding: 2px 6px; border-radius: 4px; }
    .test-result {
      margin-top: 10px;
      font-size: 13px;
      padding: 10px 14px;
      border-radius: 6px;
      display: none;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .tip-box {
      margin-top: 14px;
      padding: 12px;
      background: #1e1b4b;
      border-left: 3px solid #6366f1;
      border-radius: 6px;
      font-size: 12px;
      color: #c7d2fe;
    }
    code {
      background: #0d1322;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header Card -->
    <div class="card">
      <div class="header-row">
        <div>
          <h1>🤖 BTC EMA Ribbon Scalping Bot</h1>
          <p>Binance Futures 24/7 | Thuật toán Andrew Lockwood (5 Quy tắc Thép)</p>
        </div>
        <div class="status-badge">
          <span class="status-dot"></span> Đang trực chiến${dry ? ' (DRY RUN)' : ''}
        </div>
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-title">Giá BTC Hiện Tại</div>
          <div id="mBtcPrice" class="metric-val" style="color: #38bdf8;">Đang tải...</div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Vốn & Đòn bẩy</div>
          <div class="metric-val">${cfg.capital}$ <span style="font-size: 13px; color: #94a3b8;">x ${cfg.leverage}x</span></div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Thời gian chạy</div>
          <div id="mUptime" class="metric-val">${Math.floor(process.uptime() / 60)} phút</div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Tín hiệu đã phát</div>
          <div id="mAlerts" class="metric-val" style="color: #34d399;">${stats.alertsSentCount} kèo</div>
        </div>
      </div>
    </div>

    <!-- Market Analysis & Logic Breakdown -->
    <div class="card">
      <div class="header-row">
        <h2 style="font-size: 17px; margin: 0;">🧭 Đại Cục & Điều Kiện Bóp Cò Hiện Tại</h2>
        <span id="lastCheckTime" style="font-size: 12px; color: var(--text-muted);">Lần quét: Đang cập nhật...</span>
      </div>

      <div class="metrics-grid" style="margin-top: 12px;">
        <div class="metric-box">
          <div class="metric-title">Xu Hướng 1H (Đại cục)</div>
          <div id="trend1hBadge" style="margin-top: 4px;"><span class="badge badge-none">Đang quét...</span></div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Xu Hướng 15m (Đại cục)</div>
          <div id="trend15mBadge" style="margin-top: 4px;"><span class="badge badge-none">Đang quét...</span></div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Trạng Thái 3m (Bóp cò)</div>
          <div id="status3m" style="font-size: 13px; font-weight: 600; margin-top: 4px;">Đang quét...</div>
        </div>
        <div class="metric-box">
          <div class="metric-title">Trạng Thái 5m (Bóp cò)</div>
          <div id="status5m" style="font-size: 13px; font-weight: 600; margin-top: 4px;">Đang quét...</div>
        </div>
      </div>

      <div class="market-status-box">
        <div id="marketHeadline" class="status-headline">⏳ Thuật toán đang làm gì?</div>
        <div id="marketDesc" class="status-desc">
          Bot liên tục quét nến đóng của Binance Futures USDⓈ-M (BTCUSDT). Khi nến 1m, 3m hoặc 5m đóng cửa, hệ thống sẽ đối chiếu với bộ quy tắc 5 bước để xác định có tín hiệu bóp cò hay không.
        </div>
      </div>

      <div class="tip-box">
        💡 <b>Uptime Ping URL (đã cấu hình trên UptimeRobot):</b> <code>${origin}/ping</code>
      </div>
    </div>

    <!-- 5 Iron-Clad Rules Card -->
    <div class="card">
      <h2 style="font-size: 17px; margin: 0 0 4px 0;">🎯 Bộ 5 Quy Tắc Thép (Điều kiện để Bot phát Tín Hiệu)</h2>
      <p style="font-size: 13px;">Tín hiệu Alert chỉ được kích hoạt khi thị trường thỏa mãn <b>ĐỒNG THỜI CẢ 5 BƯỚC</b> sau:</p>

      <div class="rules-grid">
        <div class="rule-item">
          <b>1️⃣ Lọc Đại Cục</b>
          <p>1H & 15m phải dốc đều cùng chiều (Uptrend/Downtrend). Nếu dải EMA đan xoắn (Sideway/Chop) -> <b>Ngồi ngoài tuyệt đối</b>.</p>
        </div>
        <div class="rule-item">
          <b>2️⃣ Đếm Nến Pullback (5-8 nến)</b>
          <p>Chống FOMO: Giá phải hồi từ tốn bằng <b>5 đến 8 cây nến nhỏ</b> hướng về dải EMA. Dưới 5 nến là hồi quá nhanh, bỏ qua.</p>
        </div>
        <div class="rule-item">
          <b>3️⃣ Chống Sốc Thanh Khoản</b>
          <p>Nếu có 1-2 nến volume cực lớn đâm toạc cả dải EMA -> Bẫy giá / phá vỡ cấu trúc -> <b>Hủy kèo ngay lập tức</b>.</p>
        </div>
        <div class="rule-item">
          <b>4️⃣ Vùng Killzone (EMA8 - EMA21)</b>
          <p>Giá hồi đâm vào giữa dải EMA (chạm EMA13 hoặc 21), nhưng <b>tuyệt đối không được đóng nến vượt qua EMA21</b>.</p>
        </div>
        <div class="rule-item" style="grid-column: 1 / -1;">
          <b>5️⃣ Nến Xác Nhận Đóng Cửa (Rejection)</b>
          <p>Bắt buộc đợi nến đóng hoàn toàn: <b>Rút râu mạnh</b> hoặc <b>thân đặc</b> từ chối giá tại dải EMA. Khi thỏa mãn -> <b>Bắn tín hiệu vào lệnh Market + Đặt ngay SL và TP1, TP2</b>.</p>
        </div>
      </div>
    </div>

    <!-- Live Scan Activity Log Card -->
    <div class="card">
      <div class="header-row">
        <div>
          <h2 style="font-size: 17px; margin: 0;">📋 Nhật Ký Quét Nến Thời Gian Thực (Live Logs)</h2>
          <p style="font-size: 12px; margin-top: 2px;">Tự động cập nhật mỗi 5 giây. Ghi rõ lý do tại sao nhận/không nhận tín hiệu.</p>
        </div>
        <button id="btnScanNow" class="btn btn-scan" onclick="triggerManualScan()">
          🔄 Quét Ngay (Scan Now)
        </button>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 110px;">Thời Gian</th>
              <th style="width: 60px;">Khung</th>
              <th style="width: 100px;">Giá BTC</th>
              <th style="width: 110px;">Trạng Thái</th>
              <th>Chi Tiết Phân Tích Logic</th>
            </tr>
          </thead>
          <tbody id="logsTableBody">
            <tr>
              <td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">
                Đang nạp dữ liệu lịch sử quét...
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Test Telegram Alert Card -->
    <div class="card">
      <h2 style="font-size: 17px; margin: 0 0 4px 0;">🧪 Kiểm Tra Định Dạng Alert Telegram</h2>
      <p style="font-size: 13px;">Bấm nút bên dưới để bot bắn ngay 1 mẫu tín hiệu thực tế vào Telegram xem format hiển thị:</p>

      <div class="btn-group">
        <button id="btnLong" class="btn btn-long" onclick="testTele('LONG')">🟢 Test Mẫu Alert LONG</button>
        <button id="btnShort" class="btn btn-short" onclick="testTele('SHORT')">🔴 Test Mẫu Alert SHORT</button>
      </div>
      <div id="testRes" class="test-result">
        <div id="testMsg" style="font-weight: 700; margin-bottom: 8px;"></div>
        <pre id="testPreview" style="margin: 0; white-space: pre-wrap; font-family: inherit; font-size: 13px; line-height: 1.5;"></pre>
      </div>
    </div>
  </div>

  <script>
    function renderTrendBadge(trend) {
      if (trend === 'up') return '<span class="badge badge-up">🟢 Tăng (Uptrend)</span>';
      if (trend === 'down') return '<span class="badge badge-down">🔴 Giảm (Downtrend)</span>';
      if (trend === 'chop') return '<span class="badge badge-chop">🟡 Sideway (Chop xoắn)</span>';
      return '<span class="badge badge-none">⚪ Chưa rõ xu hướng</span>';
    }

    async function updateDashboard() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        // Uptime & Alerts
        document.getElementById('mUptime').innerText = data.uptimeMin + ' phút';
        document.getElementById('mAlerts').innerText = data.alertsSent + ' kèo';
        if (data.lastCheck) {
          document.getElementById('lastCheckTime').innerText = 'Lần quét: ' + data.lastCheck;
        }

        // Market data
        if (data.market) {
          const m = data.market;
          if (m.btcPrice) {
            document.getElementById('mBtcPrice').innerText = '$' + Number(m.btcPrice).toLocaleString('en-US', { minimumFractionDigits: 1 });
          }
          document.getElementById('trend1hBadge').innerHTML = renderTrendBadge(m.trend1h);
          document.getElementById('trend15mBadge').innerHTML = renderTrendBadge(m.trend15m);

          if (m.statusText) {
            document.getElementById('marketDesc').innerText = m.statusText;
          }

          if (m.isSynced) {
            document.getElementById('marketHeadline').innerHTML = '🎯 <b>Đại cục thuận lợi (' + (m.expectedSide === 'LONG' ? 'MUA' : 'BÁN') + '):</b> Đang tìm điểm bóp cò trên 3m & 5m';
          } else if (m.trend1h === 'chop' || m.trend15m === 'chop') {
            document.getElementById('marketHeadline').innerHTML = '⚠️ <b>Máy xay thịt (Chop):</b> Dải EMA đan xoắn, tuyệt đối không vào lệnh';
          } else {
            document.getElementById('marketHeadline').innerHTML = '⏳ <b>Đang chờ đồng pha:</b> Khung 1H và 15m chưa cùng hướng';
          }

          if (m.tfs) {
            if (m.tfs['3m']) {
              const s3 = m.tfs['3m'];
              document.getElementById('status3m').innerHTML = s3.status === 'SIGNAL' 
                ? '<span style="color: #34d399;">🚨 CÓ TÍN HIỆU</span>' 
                : '<span style="color: #fbbf24;">⏳ ' + s3.reason + '</span>';
            }
            if (m.tfs['5m']) {
              const s5 = m.tfs['5m'];
              document.getElementById('status5m').innerHTML = s5.status === 'SIGNAL' 
                ? '<span style="color: #34d399;">🚨 CÓ TÍN HIỆU</span>' 
                : '<span style="color: #fbbf24;">⏳ ' + s5.reason + '</span>';
            }
          }
        }

        // Logs table
        if (data.recentLogs && data.recentLogs.length > 0) {
          const rows = data.recentLogs.map(function(item) {
            const isSignal = item.status === 'SIGNAL';
            const badgeClass = isSignal ? 'log-signal' : 'log-nosignal';
            const statusLabel = isSignal ? '🚨 CÓ TÍN HIỆU' : 'CHỜ SETUP';
            const priceStr = item.price ? '$' + Number(item.price).toFixed(1) : '-';
            return '<tr>' +
              '<td>' + item.time.split(' ')[1] + '</td>' +
              '<td><b>' + item.tf + '</b></td>' +
              '<td>' + priceStr + '</td>' +
              '<td><span class="' + badgeClass + '">' + statusLabel + '</span></td>' +
              '<td style="color: ' + (isSignal ? '#34d399' : '#cbd5e1') + ';">' + item.reason + '</td>' +
              '</tr>';
          }).join('');
          document.getElementById('logsTableBody').innerHTML = rows;
        }
      } catch (err) {
        console.warn('Dashboard update error:', err);
      }
    }

    async function triggerManualScan() {
      const btn = document.getElementById('btnScanNow');
      btn.disabled = true;
      btn.innerHTML = '⏳ Đang quét nến Binance...';
      try {
        const res = await fetch('/api/scan');
        const data = await res.json();
        await updateDashboard();
      } catch (e) {
        alert('Lỗi quét: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '🔄 Quét Ngay (Scan Now)';
      }
    }

    async function testTele(side) {
      const btnL = document.getElementById('btnLong');
      const btnS = document.getElementById('btnShort');
      const resEl = document.getElementById('testRes');
      const msgEl = document.getElementById('testMsg');
      const prevEl = document.getElementById('testPreview');
      btnL.disabled = true;
      btnS.disabled = true;
      resEl.style.display = 'block';
      resEl.style.background = '#0d1322';
      msgEl.style.color = '#94a3b8';
      msgEl.innerText = '⏳ Đang gửi mẫu Alert ' + side + ' đến Telegram...';
      prevEl.innerText = '';
      try {
        const res = await fetch('/test-tele?side=' + side);
        const data = await res.json();
        if (data.ok) {
          resEl.style.background = '#064e3b';
          msgEl.style.color = '#34d399';
          msgEl.innerText = '✅ ' + data.message;
          prevEl.style.color = '#e2e8f0';
          prevEl.innerText = data.preview.replace(/<[^>]+>/g, '');
        } else {
          resEl.style.background = '#450a0a';
          msgEl.style.color = '#f87171';
          msgEl.innerText = '❌ Lỗi: ' + data.error;
          prevEl.innerText = '';
        }
      } catch (e) {
        resEl.style.background = '#450a0a';
        msgEl.style.color = '#f87171';
        msgEl.innerText = '❌ Lỗi kết nối: ' + e.message;
        prevEl.innerText = '';
      } finally {
        btnL.disabled = false;
        btnS.disabled = false;
      }
    }

    // Auto poll status every 4 seconds
    updateDashboard();
    setInterval(updateDashboard, 4000);
  </script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    })
    .listen(port, () => {
      console.log(`🌐 HTTP Web Service đang lắng nghe tại port ${port}`);
    });

  // Tự động Ping chính mình mỗi 10 phút (Render tự động cấp biến RENDER_EXTERNAL_URL)
  const appUrl = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (appUrl) {
    const pingTarget = appUrl.replace(/\/+$/, '') + '/ping';
    console.log(`🔄 Auto self-ping kích hoạt: ${pingTarget} (mỗi 10 phút)`);
    setInterval(async () => {
      try {
        const res = await fetch(pingTarget);
        console.log(`[${ts(Date.now())}] 🔄 Self-ping OK (status: ${res.status})`);
      } catch (e) {
        console.warn(`[${ts(Date.now())}] ⚠️ Self-ping lỗi: ${e.message}`);
      }
    }, 10 * 60 * 1000);
  }
}

async function tick(force = false) {
  const minute = Math.floor(Date.now() / 60000);
  const tfs = cfg.triggerTimeframes.filter((tf) => force || minute % parseInt(tf, 10) === 0);
  if (!tfs.length) return;

  const summaries = [];
  const [h1, m15] = await Promise.all([fetchKlines('1h'), fetchKlines('15m')]);
  const trend1h = trendOf(h1, cfg);
  const trend15m = trendOf(m15, cfg);
  const latestH1 = h1[h1.length - 1];
  const btcPrice = latestH1?.c || 0;

  const isSynced = (trend1h === 'up' || trend1h === 'down') && trend1h === trend15m;
  let statusText = 'Đang theo dõi thị trường';
  let expectedSide = null;
  if (isSynced) {
    expectedSide = trend1h === 'up' ? 'LONG' : 'SHORT';
    statusText = `✅ Đại cục đồng pha ${trend1h === 'up' ? 'TĂNG' : 'GIẢM'} (1H & 15m). Đang săn setup ${expectedSide} trên khung ${cfg.triggerTimeframes.join(', ')}`;
  } else if (trend1h === 'chop' || trend15m === 'chop') {
    statusText = '⏸ Thị trường Sideway (dải EMA đan xoắn). Bot kiên quyết ngồi ngoài bảo toàn vốn';
  } else {
    statusText = `⏸ Khung 1H (${trend1h}) và 15m (${trend15m}) chưa đồng pha. Đang chờ xác nhận xu hướng rõ ràng`;
  }

  stats.market = {
    btcPrice,
    trend1h,
    trend15m,
    isSynced,
    expectedSide,
    statusText,
    tfs: stats.market?.tfs || {},
  };

  for (const tf of tfs) {
    const candles = await fetchKlines(tf);
    const lastCandle = candles[candles.length - 1];
    const r = evaluate({ h1, m15, candles, tf, cfg });
    const at = ts(lastCandle.ct + 1);

    stats.market.tfs[tf] = {
      candleTime: at,
      closePrice: lastCandle.c,
      status: r.noSignal ? 'NO_SIGNAL' : 'SIGNAL',
      reason: r.noSignal ? r.reason : `🚨 Kèo ${r.signal.side} Entry ${r.signal.entry}`,
      signal: r.signal || null,
    };

    if (r.noSignal) {
      console.log(`[${at}] ${tf} NO_SIGNAL — ${r.reason}`);
      summaries.push(`${tf}: NO_SIGNAL (${r.reason})`);

      stats.recentLogs.unshift({
        time: ts(Date.now()),
        candleTime: at,
        tf,
        price: lastCandle.c,
        status: 'NO_SIGNAL',
        side: null,
        reason: r.reason,
      });
      continue;
    }

    if (sent.has(r.signal.key)) {
      summaries.push(`${tf}: SIGNAL (đã gửi trước đó)`);
      stats.recentLogs.unshift({
        time: ts(Date.now()),
        candleTime: at,
        tf,
        price: lastCandle.c,
        status: 'SIGNAL_DUPLICATE',
        side: r.signal.side,
        reason: `Đã phát tín hiệu trước đó (${r.signal.key})`,
      });
      continue;
    }

    sent.add(r.signal.key);
    stats.alertsSentCount++;
    summaries.push(`${tf}: 🚨 SIGNAL`);
    const text = formatAlert(r.signal, cfg);
    console.log(`[${at}] ${tf} SIGNAL\n${text}`);

    stats.recentLogs.unshift({
      time: ts(Date.now()),
      candleTime: at,
      tf,
      price: r.signal.entry,
      status: 'SIGNAL',
      side: r.signal.side,
      reason: `Entry: ${r.signal.entry} | SL: ${r.signal.sl} | TP1: ${r.signal.tp1} | TP2: ${r.signal.tp2}`,
    });

    if (!dry) await sendTelegram(cfg.telegram.token, cfg.telegram.chatId, text);
  }

  if (stats.recentLogs.length > 50) stats.recentLogs.length = 50;
  stats.lastCheckTime = new Date();
  if (summaries.length) stats.lastCheckSummary = summaries.join(' | ');
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
