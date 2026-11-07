// Real-time Binance Futures WebSocket Stream (Zero HTTP Request Architecture)
// Subscribes to tick-by-tick trades and closed klines directly over a single persistent connection.
import WebSocket from 'ws';
import { fetchKlines, dataSource } from './binance.js';

const FUTURES_WS_URL = 'wss://fstream.binance.com/market/stream?streams=';

export class MarketStream {
  constructor(cfg) {
    this.cfg = cfg;
    this.intervals = ['1h', '15m', '3m', '5m'];
    this.candles = {
      '1h': [],
      '15m': [],
      '3m': [],
      '5m': [],
    };
    this.currentPrice = 0;
    this.ws = null;
    this.status = 'disconnected';
    this.reconnectTimer = null;
    this.lastMsgTime = 0;
    this.listeners = {
      price: [],
      candleClose: [],
      status: [],
    };
  }

  on(event, fn) {
    if (this.listeners[event]) this.listeners[event].push(fn);
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      for (const fn of this.listeners[event]) {
        try {
          fn(...args);
        } catch (e) {
          console.error(`Listener error [${event}]:`, e);
        }
      }
    }
  }

  /**
   * Nạp lịch sử ban đầu (chỉ gọi 1 lần duy nhất khi khởi động bot).
   * Sau đó toàn bộ dữ liệu được cập nhật qua WebSocket mà không tốn thêm bất kỳ HTTP request nào.
   */
  async initHistory() {
    console.log('⏳ [WebSocket Stream] Khởi tạo lịch sử nến ban đầu...');
    for (const tf of this.intervals) {
      try {
        const klines = await fetchKlines(tf, 250);
        this.candles[tf] = klines;
        console.log(`✅ [Khởi tạo] Đã nạp ${klines.length} nến ${tf} từ Binance`);
      } catch (e) {
        console.warn(`⚠️ [Khởi tạo] Chưa nạp được nến ${tf}: ${e.message}`);
      }
    }
    const p3m = this.candles['3m'];
    if (p3m && p3m.length) {
      this.currentPrice = p3m[p3m.length - 1].c;
      this.emit('price', this.currentPrice);
    }
  }

  connect() {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }

    const streams = [
      'btcusdt@aggTrade',
      ...this.intervals.map((tf) => `btcusdt@kline_${tf}`),
    ].join('/');

    const url = `${FUTURES_WS_URL}${streams}`;
    this.status = 'connecting';
    this.emit('status', this.status);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('❌ [WebSocket] Lỗi khởi tạo kết nối:', err.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.status = 'connected';
      this.lastMsgTime = Date.now();
      console.log('⚡️ [WebSocket] Đã kết nối trực tiếp sàn Binance Futures! (0 HTTP Request/min, cập nhật tick-by-tick)');
      this.emit('status', this.status);
    });

    this.ws.on('message', (raw) => {
      try {
        this.lastMsgTime = Date.now();
        const msg = JSON.parse(raw.toString());
        if (!msg.data) return;

        // 1. Nhận giá Realtime tick-by-tick từ từng giao dịch aggTrade
        if (msg.stream?.includes('aggTrade')) {
          const px = Number(msg.data.p);
          if (px && px !== this.currentPrice) {
            this.currentPrice = px;
            this.emit('price', px);
          }
          return;
        }

        // 2. Nhận cập nhật nến Klines
        if (msg.data.e === 'kline' && msg.data.k) {
          const k = msg.data.k;
          const tf = k.i;
          const isClosed = k.x === true;

          // Cập nhật giá tức thì từ nến
          const closePx = Number(k.c);
          if (closePx && closePx !== this.currentPrice) {
            this.currentPrice = closePx;
            this.emit('price', closePx);
          }

          // Khi cây nến chính thức đóng cửa (k.x === true)
          if (isClosed && this.candles[tf]) {
            const candle = {
              t: k.t,
              o: +k.o,
              h: +k.h,
              l: +k.l,
              c: +k.c,
              v: +k.v,
              ct: k.T,
            };

            const arr = this.candles[tf];
            const last = arr[arr.length - 1];
            if (!last || candle.t > last.t) {
              arr.push(candle);
              if (arr.length > 300) arr.shift();
            } else if (last && candle.t === last.t) {
              arr[arr.length - 1] = candle;
            }

            this.emit('candleClose', tf, candle, this.candles);
          }
        }
      } catch (err) {
        console.error('WS parse error:', err.message);
      }
    });

    this.ws.on('error', (err) => {
      console.warn('⚠️ [WebSocket] Gặp sự cố kết nối:', err.message);
    });

    this.ws.on('close', () => {
      this.status = 'disconnected';
      this.emit('status', this.status);
      console.warn('🔄 [WebSocket] Mất kết nối, tự động kết nối lại sau 3s...');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 3000);
  }

  stop() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.status = 'stopped';
  }
}
