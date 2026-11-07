// Real-time Binance SPOT prices over ONE WebSocket (market-data-only host; streams do not use REST weight).
// Streams per coin: <sym>@kline_1m (closed 1-minute bars -> SL/TP and MFE/MAE in real time)
//                   <sym>@kline_1d (today's live daily candle -> "if it closed now" watchlist)
// Robustness: watchdog for silent sockets, exponential backoff with jitter (Binance may ban IPs that
// reconnect too often), handles Binance's forced 24h disconnect. Missing minutes are filled by REST.
import WebSocket from 'ws';

const MAX_BACKOFF = 60e3;
const STABLE_MS = 60e3;

export class LiveFeed {
  constructor({ symbols, base = process.env.SWING_WS_BASE || 'wss://data-stream.binance.vision', staleMs = 60e3, onBar, onStatus = () => {}, log = console, WS = WebSocket, now = Date.now }) {
    Object.assign(this, { symbols, base, staleMs, onBar, onStatus, log, WS, now });
    this.prices = {};
    this.daily = {};
    this.ws = null;
    this.status = 'idle';
    this.attempt = 0;
    this.stopped = false;
    this.stats = { messages: 0, bars: 0, reconnects: 0, connectedAt: null, lastMsgAt: null };
  }

  url() {
    const streams = this.symbols.flatMap((s) => [`${s.toLowerCase()}@kline_1m`, `${s.toLowerCase()}@kline_1d`]);
    return `${this.base}/stream?streams=${streams.join('/')}`;
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.check(), 10e3);
    this.watchdog.unref?.();
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const old = this.ws;
    this.ws = null;
    if (old) try { old.terminate(); } catch { /* already closed */ }
    this.setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(this.url());
    } catch (e) {
      this.log.warn?.(`⚠️ [Realtime] Không tạo được WebSocket: ${e.message}`);
      return this.reconnectLater();
    }
    this.ws = ws;
    this.stats.lastMsgAt = this.now(); // the watchdog also bounds the handshake
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.stats.connectedAt = this.now();
      this.setStatus('connected');
      this.log.log?.(`⚡ [Realtime] Đã kết nối giá realtime Binance spot (${this.symbols.length} coin)`);
    });
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      this.stats.lastMsgAt = this.now();
      this.stats.messages++;
      try {
        this.handle(JSON.parse(raw.toString()));
      } catch (e) {
        this.log.warn?.(`⚠️ [Realtime] Message lỗi: ${e.message}`);
      }
    });
    ws.on('error', (e) => {
      if (this.ws === ws) this.log.warn?.(`⚠️ [Realtime] ${e.message}`);
    }); // keep a listener: an 'error' without listener would crash the process
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('disconnected');
      this.reconnectLater();
    });
  }

  handle(msg) {
    const d = msg.data;
    if (!d || d.e !== 'kline' || !d.k) return;
    const k = d.k, sym = d.s;
    const bar = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, ct: k.T };
    if (Number.isFinite(bar.c)) this.prices[sym] = bar.c;
    if (k.i === '1d') this.daily[sym] = bar;
    else if (k.i === '1m' && k.x === true) {
      this.stats.bars++;
      this.onBar(sym, bar);
    }
  }

  reconnectLater() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const base = Math.min(MAX_BACKOFF, 1000 * 2 ** this.attempt);
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.attempt++;
    this.stats.reconnects++;
    this.log.warn?.(`🔄 [Realtime] Mất kết nối, thử lại sau ${(delay / 1000).toFixed(1)}s (lần ${this.attempt})`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  check() {
    const now = this.now();
    if (this.ws && now - this.stats.lastMsgAt > this.staleMs) {
      this.log.warn?.(`⚠️ [Realtime] ${Math.round((now - this.stats.lastMsgAt) / 1000)}s không có dữ liệu → kết nối lại`);
      this.ws.terminate(); // -> 'close' -> reconnectLater()
    }
    if (this.status === 'connected' && this.attempt && now - this.stats.connectedAt > STABLE_MS) this.attempt = 0;
  }

  healthy() {
    return this.status === 'connected' && this.now() - (this.stats.lastMsgAt ?? 0) < this.staleMs;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.terminate(); } catch { /* already closed */ }
    this.setStatus('stopped');
  }
}
