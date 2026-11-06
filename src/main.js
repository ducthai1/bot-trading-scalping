// Live bot: every minute (+closeDelayMs) evaluate the trigger TFs whose candle just closed.
import http from 'node:http';
import { loadConfig, checkNotional } from './config.js';
import { fetchKlines } from './binance.js';
import { evaluate } from './strategy.js';
import { formatAlert } from './format.js';
import { sendTelegram } from './telegram.js';

const dry = process.argv.includes('--dry');
const cfg = loadConfig();
const sent = new Set();
const ts = (ms) => new Date(ms).toLocaleString('vi-VN', { hour12: false });

// Thống kê hoạt động của bot
const stats = {
  startTime: new Date(),
  lastCheckTime: null,
  lastCheckSummary: 'Đang khởi động...',
  alertsSentCount: 0,
};

checkNotional(cfg);
if (!dry && (!cfg.telegram.token || !cfg.telegram.chatId)) {
  console.error('Thiếu Telegram token/chatId (config.json hoặc env TELEGRAM_TOKEN, TELEGRAM_CHAT_ID). Chạy thử: npm run dry');
  process.exit(1);
}

// Mở HTTP server healthcheck khi chạy trên Render Web Service / Koyeb (process.env.PORT)
const port = process.env.PORT;
if (port) {
  http
    .createServer((req, res) => {
      const host = req.headers.host || `localhost:${port}`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${host}`;
      const url = new URL(req.url, origin);

      // Endpoint API cho UptimeRobot / cron-job / monitoring
      if (url.pathname === '/ping' || url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            status: 'ok',
            service: 'btc-ema-ribbon-alert',
            uptimeMin: Math.floor(process.uptime() / 60),
            lastCheck: stats.lastCheckTime ? ts(stats.lastCheckTime.getTime()) : null,
            lastSummary: stats.lastCheckSummary,
            alertsSent: stats.alertsSentCount,
            dryRun: dry,
          })
        );
      }

      // Endpoint kiểm tra gửi tin nhắn Telegram
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
        sendTelegram(
          cfg.telegram.token,
          cfg.telegram.chatId,
          `🔔 <b>Test Bot</b>: Kết nối Telegram thành công!\nBot EMA Ribbon Scalping đang chạy online 24/7 trên Render.\nThời gian: ${ts(Date.now())}`
        )
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, message: 'Đã gửi tin nhắn test thành công tới Telegram!' }));
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
  <title>BTC EMA Ribbon Scalping Bot</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 16px; box-sizing: border-box; }
    .card { background: #1e293b; border-radius: 14px; padding: 24px; max-width: 500px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .status { display: inline-flex; align-items: center; gap: 8px; background: #064e3b; color: #34d399; padding: 6px 14px; border-radius: 999px; font-weight: 600; font-size: 13px; margin-bottom: 14px; }
    .status-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981; }
    h1 { font-size: 20px; margin: 0 0 6px 0; }
    p { margin: 4px 0; color: #94a3b8; font-size: 14px; }
    .grid { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .box { background: #0f172a; padding: 12px; border-radius: 8px; border: 1px solid #334155; }
    .box-title { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 700; margin-bottom: 4px; }
    .box-val { font-size: 16px; font-weight: 600; color: #e2e8f0; }
    .tip { margin-top: 18px; padding: 12px; background: #1e1b4b; border-left: 3px solid #6366f1; border-radius: 6px; font-size: 13px; color: #c7d2fe; }
    code { background: #0f172a; padding: 3px 6px; border-radius: 4px; font-family: monospace; color: #38bdf8; display: inline-block; margin-top: 4px; word-break: break-all; }
    .btn-test { margin-top: 16px; width: 100%; background: #2563eb; color: #ffffff; border: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; transition: background 0.2s; }
    .btn-test:hover { background: #1d4ed8; }
    .btn-test:disabled { background: #475569; cursor: not-allowed; }
    .test-result { margin-top: 10px; font-size: 13px; padding: 8px 12px; border-radius: 6px; display: none; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="status-dot"></span> Đang chạy 24/7${dry ? ' (DRY RUN)' : ''}</div>
    <h1>🤖 BTC EMA Ribbon Scalping Bot</h1>
    <p>Khung quét: <b>${cfg.triggerTimeframes.join(', ')}</b> | Đòn bẩy: <b>${cfg.leverage}x</b> | Vốn: <b>${cfg.capital}$</b></p>
    <div class="grid">
      <div class="box">
        <div class="box-title">Thời gian chạy</div>
        <div class="box-val">${Math.floor(process.uptime() / 60)} phút</div>
      </div>
      <div class="box">
        <div class="box-title">Tín hiệu đã gửi</div>
        <div class="box-val">${stats.alertsSentCount} kèo</div>
      </div>
      <div class="box" style="grid-column: span 2;">
        <div class="box-title">Lần quét gần nhất</div>
        <div class="box-val" style="font-size: 13px;">${stats.lastCheckTime ? ts(stats.lastCheckTime.getTime()) : 'Đang quét nến đầu tiên...'}</div>
        <p style="margin-top: 6px; font-size: 12px; color: #94a3b8;">${stats.lastCheckSummary}</p>
      </div>
    </div>
    <div class="tip">
      💡 <b>URL Ping để giữ bot thức (UptimeRobot / Cron-job):</b><br/>
      <code>${origin}/ping</code>
    </div>

    <button id="btnTest" class="btn-test" onclick="testTele()">🧪 Bấm để gửi tin nhắn Test Telegram</button>
    <div id="testRes" class="test-result"></div>
  </div>

  <script>
    async function testTele() {
      const btn = document.getElementById('btnTest');
      const resEl = document.getElementById('testRes');
      btn.disabled = true;
      btn.innerText = '⏳ Đang gửi tin nhắn Telegram...';
      resEl.style.display = 'none';
      try {
        const res = await fetch('/test-tele');
        const data = await res.json();
        resEl.style.display = 'block';
        if (data.ok) {
          resEl.style.background = '#064e3b';
          resEl.style.color = '#34d399';
          resEl.innerText = '✅ ' + data.message;
        } else {
          resEl.style.background = '#450a0a';
          resEl.style.color = '#f87171';
          resEl.innerText = '❌ Lỗi: ' + data.error;
        }
      } catch (e) {
        resEl.style.display = 'block';
        resEl.style.background = '#450a0a';
        resEl.style.color = '#f87171';
        resEl.innerText = '❌ Lỗi kết nối: ' + e.message;
      } finally {
        btn.disabled = false;
        btn.innerText = '🧪 Bấm để gửi tin nhắn Test Telegram';
      }
    }
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
  for (const tf of tfs) {
    const candles = await fetchKlines(tf);
    const r = evaluate({ h1, m15, candles, tf, cfg });
    const at = ts(candles[candles.length - 1].ct + 1);
    if (r.noSignal) {
      console.log(`[${at}] ${tf} NO_SIGNAL — ${r.reason}`);
      summaries.push(`${tf}: NO_SIGNAL (${r.reason})`);
      continue;
    }
    if (sent.has(r.signal.key)) {
      summaries.push(`${tf}: SIGNAL (đã gửi trước đó)`);
      continue;
    }
    sent.add(r.signal.key);
    stats.alertsSentCount++;
    summaries.push(`${tf}: 🚨 SIGNAL`);
    const text = formatAlert(r.signal, cfg);
    console.log(`[${at}] ${tf} SIGNAL\n${text}`);
    if (!dry) await sendTelegram(cfg.telegram.token, cfg.telegram.chatId, text);
  }

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
