// Đếm số lần thử kết nối WS khi KHÔNG có mạng trong N giây (đo nhịp reconnect / backoff).
import { MarketStream } from '/app/src/ws-stream.js';

const SECS = Number(process.argv[2]) || 30;
const s = new MarketStream({});
const times = [];
const orig = s.connect.bind(s);
s.connect = (...a) => {
  times.push(Date.now());
  return orig(...a);
};
const log = console.warn;
console.warn = () => {};
console.error = () => {};
s.connect();
setTimeout(() => {
  const gaps = times.slice(1).map((t, i) => ((t - times[i]) / 1000).toFixed(1));
  log(`${times.length} lần kết nối trong ${SECS}s; khoảng cách (s): ${gaps.join(', ')}`);
  log(`=> ước tính ${Math.round((times.length / SECS) * 300)} lần / 5 phút`);
  process.exit(0);
}, SECS * 1000);
