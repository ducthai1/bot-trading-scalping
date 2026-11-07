// Chạy MarketStream của repo, in trạng thái mỗi 5s: số message theo stream, số lần connect, nến & lỗ hổng.
// node _sbx/ws-probe.mjs <seconds>
import { MarketStream } from '/app/src/ws-stream.js';

const SECS = Number(process.argv[2]) || 60;
const cfg = (await import('/app/src/config.js')).loadConfig();
const s = new MarketStream(cfg);
const STEP = { '1h': 3600e3, '15m': 900e3, '5m': 300e3, '3m': 180e3 };
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`.padStart(4);

let connects = 0;
const origConnect = s.connect.bind(s);
s.connect = (...a) => {
  connects++;
  return origConnect(...a);
};
const counts = {};
const origEmit = s.emit.bind(s);
let lastCountsAt = Date.now();
let msgs = 0;
s.on('status', (st) => console.log(`${el()} status=${st}`));
s.on('candleClose', (tf, k) => console.log(`${el()} candleClose ${tf} t=${new Date(k.t).toISOString().slice(11, 16)}`));
s.emit = (ev, ...a) => {
  if (ev === 'price') msgs++;
  return origEmit(ev, ...a);
};
// Count raw messages per stream by peeking at the socket.
const hook = () => {
  if (s.ws && !s.ws.__probed) {
    s.ws.__probed = true;
    s.ws.on('message', (raw) => {
      const st = JSON.parse(raw.toString()).stream || '?';
      counts[st] = (counts[st] || 0) + 1;
    });
  }
};

function gaps() {
  const g = {};
  for (const [tf, arr] of Object.entries(s.candles)) {
    let n = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i].t - arr[i - 1].t !== STEP[tf]) n++;
    g[tf] = `${arr.length}${n ? ` GAP×${n}` : ''}`;
  }
  return JSON.stringify(g);
}

await s.initHistory();
s.connect();
const iv = setInterval(() => {
  hook();
  const dt = (Date.now() - lastCountsAt) / 1000;
  lastCountsAt = Date.now();
  const rate = Object.entries(counts).map(([k, v]) => `${k.replace('btcusdt@', '')}=${(v / dt).toFixed(1)}/s`).join(' ');
  for (const k of Object.keys(counts)) counts[k] = 0;
  const silent = s.lastMsgTime ? Math.round((Date.now() - s.lastMsgTime) / 1000) : -1;
  console.log(`${el()} ws=${s.status} connects=${connects} silentFor=${silent}s rate[${rate}] candles=${gaps()}`);
}, 5000);
setTimeout(() => {
  clearInterval(iv);
  console.log(`${el()} END connects=${connects}`);
  process.exit(0);
}, SECS * 1000);
