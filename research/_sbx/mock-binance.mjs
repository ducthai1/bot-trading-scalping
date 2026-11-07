// Máy chủ Binance GIẢ cho test tích hợp: dữ liệu dựng sẵn để chắc chắn có tín hiệu R3 (AAVEUSDT) và
// Breakout (LINKUSDT) ở nến đóng cửa hôm qua. MODE=ban -> mọi /klines trả 418 (giả lập bị ban IP).
import http from 'node:http';
import { readFileSync } from 'node:fs';

const DAY = 86400e3, HOUR = 3600e3;
const cfg = JSON.parse(readFileSync('/app/swing/config.json', 'utf8'));
const today = Math.floor(Date.now() / DAY) * DAY;
const N = 300; // closed daily candles, last one = yesterday
const daily = {}, hourly = {}, minutes = {};
for (const s of cfg.coins) {
  const rows = [];
  let p = 50;
  for (let k = N; k >= 1; k--) {
    const t = today - k * DAY;
    let o = p, c = p, h = p, l = p;
    if (s === 'BTCUSDT') { c = p * 1.003; h = c; l = o; }
    if (s === 'AAVEUSDT') { if (k > 4) { c = p * 1.004; h = c * 1.005; l = o * 0.995; } else { c = p * 0.975; h = o; l = c * 0.99; } }
    if (s === 'LINKUSDT' && k === 1) { c = p * 1.08; h = c; l = o; }
    rows.push({ t, o, h, l, c });
    p = c;
  }
  rows.push({ t: today, o: p, h: p, l: p, c: p, forming: true });
  daily[s] = rows;
  const hrs = [];
  for (let t = today; t + HOUR <= Date.now(); t += HOUR) {
    // LINK pumps 30% at 10:00 UTC today -> breakout TP; everything else flat
    const up = s === 'LINKUSDT' && t >= today + 10 * HOUR;
    const px = up ? p * 1.3 : p;
    hrs.push({ t, o: px, h: px, l: px, c: px });
  }
  hourly[s] = hrs;
  const mins = [];
  for (let t = today; t + 60e3 <= Date.now(); t += 60e3) {
    const up = s === 'LINKUSDT' && t >= today + 10 * HOUR;
    const px = up ? p * 1.3 : p;
    mins.push({ t, o: px, h: px, l: px, c: px });
  }
  minutes[s] = mins;
}
const asRow = (k, ms) => [k.t, String(k.o), String(k.h), String(k.l), String(k.c), '1000', Math.min(k.t + ms - 1, k.forming ? Date.now() : k.t + ms - 1)];
let requests = 0;
http.createServer((req, res) => {
  requests++;
  const u = new URL(req.url, 'http://x');
  const json = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/__count') return json(200, { requests });
  if (u.pathname === '/api/v3/time') return json(200, { serverTime: Date.now() });
  if (u.pathname === '/api/v3/exchangeInfo') {
    const syms = JSON.parse(u.searchParams.get('symbols'));
    return json(200, { symbols: syms.map((symbol) => ({ symbol, status: 'TRADING', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00100000', minQty: '0.001' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }, { filterType: 'PRICE_FILTER', tickSize: '0.00010000' }] })) });
  }
  if (u.pathname === '/api/v3/ticker/price') {
    const syms = JSON.parse(u.searchParams.get('symbols'));
    return json(200, syms.map((symbol) => ({ symbol, price: String((hourly[symbol].at(-1) ?? daily[symbol].at(-1)).c) })));
  }
  if (u.pathname === '/api/v3/klines') {
    if (process.env.MODE === 'ban') return json(418, { code: -1003, msg: 'banned' }, { 'retry-after': '30' });
    const s = u.searchParams.get('symbol'), iv = u.searchParams.get('interval');
    const st = Number(u.searchParams.get('startTime') ?? 0), en = Number(u.searchParams.get('endTime') ?? Infinity), lim = Number(u.searchParams.get('limit') ?? 500);
    const src = iv === '1d' ? daily[s] : iv === '1m' ? minutes[s] : hourly[s];
    const ms = iv === '1d' ? DAY : iv === '1m' ? 60e3 : HOUR;
    let rows = src.filter((k) => k.t >= st && k.t <= en);
    rows = u.searchParams.has('startTime') ? rows.slice(0, lim) : rows.slice(-lim);
    return json(200, rows.map((k) => asRow(k, ms)));
  }
  json(404, { msg: 'not found' });
}).listen(4000, '127.0.0.1');

// ---- WebSocket: pushes the live daily candle + the last closed 1-minute bar every 2 s
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 4001, host: '127.0.0.1' });
wss.on('connection', (ws, req) => {
  const syms = new URL(req.url, 'http://x').searchParams.get('streams').split('/').filter((x) => x.endsWith('@kline_1d')).map((x) => x.split('@')[0].toUpperCase());
  const push = () => {
    for (const s of syms) {
      const d = daily[s].at(-1);
      ws.send(JSON.stringify({ stream: `${s.toLowerCase()}@kline_1d`, data: { e: 'kline', s, k: { i: '1d', x: false, t: d.t, T: d.t + DAY - 1, o: String(d.o), h: String(d.h), l: String(d.l), c: String(d.c), v: '1' } } }));
      const m = minutes[s].at(-1);
      if (m) ws.send(JSON.stringify({ stream: `${s.toLowerCase()}@kline_1m`, data: { e: 'kline', s, k: { i: '1m', x: true, t: m.t, T: m.t + 60e3 - 1, o: String(m.o), h: String(m.h), l: String(m.l), c: String(m.c), v: '1' } } }));
    }
  };
  push();
  const iv = setInterval(push, 2000);
  ws.on('close', () => clearInterval(iv));
});
