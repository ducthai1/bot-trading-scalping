// Tái hiện: mất kết nối đúng lúc nến đóng -> mảng nến bị thủng (không có mạng, bơm message giả vào socket).
import { MarketStream } from '/app/src/ws-stream.js';

const STEP = 180e3;
const s = new MarketStream({});
const t0 = Math.floor(Date.now() / STEP) * STEP - 10 * STEP;
s.candles['3m'] = Array.from({ length: 5 }, (_, i) => ({ t: t0 + i * STEP, o: 1, h: 1, l: 1, c: 1, v: 1, ct: t0 + (i + 1) * STEP - 1 }));
s.scheduleReconnect = () => {}; // không cần vòng reconnect thật trong test này
s.connect();
const kline = (t) => Buffer.from(JSON.stringify({ stream: 'btcusdt@kline_3m', data: { e: 'kline', k: { i: '3m', t, T: t + STEP - 1, o: '1', h: '1', l: '1', c: '1', v: '1', x: true } } }));
// nến #5 đóng bình thường
s.ws.emit('message', kline(t0 + 5 * STEP));
// ... mất kết nối: nến #6 đóng khi đang reconnect -> không nhận được
// kết nối lại, nến #7 đóng
s.ws.emit('message', kline(t0 + 7 * STEP));
const arr = s.candles['3m'];
const holes = [];
for (let i = 1; i < arr.length; i++) if (arr[i].t - arr[i - 1].t !== STEP) holes.push(`${(arr[i - 1].t - t0) / STEP}->${(arr[i].t - t0) / STEP}`);
console.log(`nến trong bộ nhớ: ${arr.map((k) => (k.t - t0) / STEP).join(',')}`);
console.log(holes.length ? `❌ THỦNG: ${holes.join(' ')} (không phát hiện, không backfill)` : '✅ liền mạch');
process.exit(0);
