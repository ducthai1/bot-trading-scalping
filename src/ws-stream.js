// Real-time Binance Futures WebSocket stream (closed klines only).
// REST is used only to seed history once and to fill holes (missed closes during a reconnect),
// never on a timer, so the bot sends ~0 HTTP requests while the socket is healthy.
import WebSocket from 'ws';
import { fetchKlines } from './binance.js';

const FUTURES_WS_URL = 'wss://fstream.binance.com/market/stream?streams=';
export const TF_MS = { '1h': 3600e3, '15m': 900e3, '5m': 300e3, '3m': 180e3 };
const MAX_CANDLES = 300;
const MAX_BACKOFF_MS = 60e3;
const STABLE_MS = 60e3; // a connection alive this long resets the backoff
const SYNC_RETRY_MS = 60e3; // min spacing between two REST gap-fills of one timeframe
const CLOSE_GRACE_MS = 15e3; // the WS close message normally lands <1s after the boundary

export class MarketStream {
  constructor(cfg, { fetch = fetchKlines, WS = WebSocket, now = Date.now } = {}) {
    this.cfg = cfg;
    this.fetch = fetch;
    this.WS = WS;
    this.now = now;
    this.intervals = ['1h', '15m', '3m', '5m'];
    this.candles = Object.fromEntries(this.intervals.map((tf) => [tf, []]));
    this.syncing = {}; // tf -> in-flight Promise
    this.lastSyncTry = {}; // tf -> epoch ms
    this.currentPrice = 0;
    this.ws = null;
    this.status = 'disconnected';
    this.stopped = false;
    this.attempt = 0;
    this.reconnectTimer = null;
    this.watchdog = null;
    this.lastMsgTime = 0;
    this.openedAt = 0;
    this.staleMs = cfg.wsStaleMs || 30000;
    this.listeners = { price: [], candleClose: [], status: [] };
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.listeners[event] || []) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`Listener error [${event}]:`, e);
      }
    }
  }

  setStatus(st) {
    this.status = st;
    this.emit('status', st);
  }

  // Seed history once at startup. A timeframe that fails stays empty and is retried by the watchdog.
  async initHistory() {
    console.log('⏳ [WebSocket Stream] Khởi tạo lịch sử nến ban đầu...');
    for (const tf of this.intervals) {
      if (await this.sync(tf)) console.log(`✅ [Khởi tạo] Đã nạp ${this.candles[tf].length} nến ${tf} từ Binance`);
    }
    const last = this.candles['3m'].at(-1);
    if (last) {
      this.currentPrice = last.c;
      this.emit('price', last.c);
    }
  }

  // Holes are closed candles missing between two stored ones, or after the last one
  // (graceMs: how long after the boundary a missing close still counts as "on its way").
  missingFrom(tf, graceMs = 0) {
    const arr = this.candles[tf];
    const step = TF_MS[tf];
    for (let i = 1; i < arr.length; i++) if (arr[i].t !== arr[i - 1].t + step) return arr[i - 1].t + step;
    const last = arr.at(-1);
    if (last && this.now() >= last.t + 2 * step + graceMs) return last.t + step; // next candle already closed
    return null;
  }

  isContiguous(tf) {
    const arr = this.candles[tf];
    for (let i = 1; i < arr.length; i++) if (arr[i].t !== arr[i - 1].t + TF_MS[tf]) return false;
    return true;
  }

  // Data is usable when it has no hole, nothing is missing at the end and no fill is running.
  isReady(tf) {
    return this.candles[tf].length > 0 && !this.syncing[tf] && this.missingFrom(tf) === null;
  }

  merge(tf, rows) {
    const byT = new Map(this.candles[tf].map((k) => [k.t, k]));
    for (const k of rows) byT.set(k.t, k);
    this.candles[tf] = [...byT.values()].sort((a, b) => a.t - b.t).slice(-MAX_CANDLES);
  }

  // One REST call (futures only) that loads history or fills holes. Returns true when the data is complete.
  sync(tf) {
    if (this.syncing[tf]) return this.syncing[tf];
    const empty = !this.candles[tf].length;
    const from = empty ? null : this.missingFrom(tf);
    if (!empty && from === null) return Promise.resolve(true);
    if (this.now() - (this.lastSyncTry[tf] || 0) < SYNC_RETRY_MS) return Promise.resolve(false);
    this.lastSyncTry[tf] = this.now();
    // A hole wider than one page is cheaper to reload than to page through.
    const tooOld = from !== null && (this.now() - from) / TF_MS[tf] > 1000;
    const p = (async () => {
      try {
        const rows = empty || tooOld ? await this.fetch(tf, MAX_CANDLES) : await this.fetch(tf, 1000, { startTime: from });
        if (tooOld) this.candles[tf] = [];
        this.merge(tf, rows);
        if (!empty) console.log(`🩹 [WebSocket] Đã vá ${rows.length} nến ${tf} bị thiếu`);
        return this.missingFrom(tf) === null;
      } catch (e) {
        console.warn(`⚠️ [Đồng bộ ${tf}] ${e.message}`);
        return false;
      } finally {
        delete this.syncing[tf];
      }
    })();
    this.syncing[tf] = p;
    return p;
  }

  syncAll() {
    return Promise.all(this.intervals.map((tf) => this.sync(tf)));
  }

  async onClosed(tf, candle) {
    const arr = this.candles[tf];
    const last = arr.at(-1);
    if (last && candle.t <= last.t) {
      if (candle.t === last.t) arr[arr.length - 1] = candle;
      return;
    }
    const hole = last && candle.t > last.t + TF_MS[tf];
    this.merge(tf, [candle]);
    if (hole) await this.sync(tf);
    this.emit('candleClose', tf, candle, this.candles);
  }

  handle(msg) {
    const k = msg.data?.k;
    if (msg.data?.e !== 'kline' || !k) return;
    const px = Number(k.c);
    if (px && px !== this.currentPrice) {
      this.currentPrice = px;
      this.emit('price', px);
    }
    if (k.x !== true || !this.candles[k.i]) return;
    this.onClosed(k.i, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, ct: k.T });
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.terminate();
      } catch {}
    }

    const streams = this.intervals.map((tf) => `btcusdt@kline_${tf}`).join('/');
    this.setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(`${FUTURES_WS_URL}${streams}`);
    } catch (err) {
      console.error('❌ [WebSocket] Lỗi khởi tạo kết nối:', err.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMsgTime = this.now(); // the watchdog also bounds the handshake

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.openedAt = this.now();
      this.lastMsgTime = this.now();
      this.setStatus('connected');
      console.log('⚡️ [WebSocket] Đã kết nối Binance Futures (kline 1h/15m/5m/3m)');
      this.syncAll(); // candles that closed while we were away
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      this.lastMsgTime = this.now();
      try {
        this.handle(JSON.parse(raw.toString()));
      } catch (err) {
        console.error('WS parse error:', err.message);
      }
    });

    // Keep this listener even after terminate(): an 'error' with no listener crashes the process.
    ws.on('error', (err) => {
      if (this.ws === ws) console.warn('⚠️ [WebSocket] Gặp sự cố kết nối:', err.message);
    });

    ws.on('close', () => {
      if (this.ws !== ws) return; // an old socket we replaced on purpose
      this.ws = null;
      this.setStatus('disconnected');
      this.scheduleReconnect();
    });

    this.startWatchdog();
  }

  // Exponential backoff with jitter: ~1s, 2s, 4s ... capped at 60s. Binance may ban IPs that reconnect too often.
  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    const delay = Math.round(base / 2 + (Math.random() * base) / 2);
    this.attempt++;
    console.warn(`🔄 [WebSocket] Mất kết nối, thử lại sau ${(delay / 1000).toFixed(1)}s (lần ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // Detects silent (half-open) sockets and retries pending gap-fills.
  startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      const now = this.now();
      if (this.ws && now - this.lastMsgTime > this.staleMs) {
        console.warn(`⚠️ [WebSocket] ${Math.round((now - this.lastMsgTime) / 1000)}s không nhận dữ liệu → kết nối lại`);
        this.ws.terminate(); // emits 'close' -> scheduleReconnect()
      }
      if (this.status === 'connected' && this.attempt && now - this.openedAt > STABLE_MS) this.attempt = 0;
      if (this.status === 'connected') {
        for (const tf of this.intervals) if (!this.candles[tf].length || this.missingFrom(tf, CLOSE_GRACE_MS) !== null) this.sync(tf);
      }
    }, 5000);
    this.watchdog.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    this.watchdog = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {}
    }
    this.setStatus('stopped');
  }
}
