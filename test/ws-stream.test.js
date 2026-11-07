import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MarketStream, TF_MS } from '../src/ws-stream.js';
import { SignalGate } from '../src/signal-gate.js';

const STEP = TF_MS['3m'];
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % STEP);
const K = (i) => ({ t: T0 + i * STEP, o: 1, h: 1, l: 1, c: 1, v: 1, ct: T0 + (i + 1) * STEP - 1 });
const closedMsg = (i) =>
  Buffer.from(JSON.stringify({ stream: 'btcusdt@kline_3m', data: { e: 'kline', k: { i: '3m', t: T0 + i * STEP, T: T0 + (i + 1) * STEP - 1, o: '1', h: '1', l: '1', c: '1', v: '1', x: true } } }));
const quiet = () => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
};

class FakeWS extends EventEmitter {
  static all = [];
  static failFast = false;
  constructor(url) {
    super();
    this.url = url;
    this.terminated = false;
    FakeWS.all.push(this);
    if (FakeWS.failFast) setTimeout(() => this.emit('close'), 0);
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('close');
  }
}
const reset = () => {
  FakeWS.all = [];
  FakeWS.failFast = false;
};

test('Chỉ subscribe kline (không còn aggTrade)', () => {
  reset();
  quiet();
  const s = new MarketStream({}, { WS: FakeWS, fetch: async () => [] });
  s.connect();
  assert.match(FakeWS.all[0].url, /btcusdt@kline_3m/);
  assert.doesNotMatch(FakeWS.all[0].url, /aggTrade/);
  s.stop();
  mock.restoreAll();
});

test('Mất 1 nến lúc reconnect -> phát hiện lỗ, vá bằng đúng 1 request REST', async () => {
  reset();
  quiet();
  const calls = [];
  const fetch = async (tf, limit, opt = {}) => {
    calls.push({ tf, limit, ...opt });
    return [K(6)];
  };
  const s = new MarketStream({}, { fetch, WS: FakeWS, now: () => T0 + 8 * STEP + 5000 });
  s.candles['3m'] = [0, 1, 2, 3, 4, 5].map(K);
  const closes = [];
  s.on('candleClose', (tf, k) => closes.push((k.t - T0) / STEP));
  s.connect();
  FakeWS.all[0].emit('message', closedMsg(7)); // nến #6 đã lỡ trong lúc mất kết nối
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startTime, T0 + 6 * STEP);
  assert.deepEqual(s.candles['3m'].map((k) => (k.t - T0) / STEP), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(s.isReady('3m'));
  assert.deepEqual(closes, [7]);
  s.stop();
  mock.restoreAll();
});

test('Vá lỗi thất bại -> isReady=false (bot không đánh giá trên dữ liệu thủng) và không spam REST', async () => {
  reset();
  quiet();
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error('418');
  };
  const s = new MarketStream({}, { fetch, WS: FakeWS, now: () => T0 + 8 * STEP + 5000 });
  s.candles['3m'] = [0, 1, 2, 3, 4, 5].map(K);
  s.connect();
  FakeWS.all[0].emit('message', closedMsg(7));
  await new Promise((r) => setImmediate(r));
  assert.equal(s.isReady('3m'), false);
  await s.sync('3m'); // gọi lại ngay -> bị giãn cách, không gửi request
  assert.equal(calls, 1);
  s.stop();
  mock.restoreAll();
});

test('Kết nối lỗi liên tục -> backoff, không quá ~20 lần / 5 phút (code cũ: ~100)', () => {
  reset();
  quiet();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  FakeWS.failFast = true;
  const s = new MarketStream({}, { WS: FakeWS, fetch: async () => [] });
  s.connect();
  for (let i = 0; i < 300; i++) mock.timers.tick(1000);
  const n = FakeWS.all.length;
  s.stop();
  mock.timers.reset();
  mock.restoreAll();
  assert.ok(n >= 5 && n <= 20, `${n} lần kết nối`);
});

test('Socket im lặng (half-open) -> watchdog ngắt và kết nối lại', () => {
  reset();
  quiet();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const s = new MarketStream({ wsStaleMs: 30000 }, { WS: FakeWS, fetch: async () => [] });
  s.connect();
  const first = FakeWS.all[0];
  first.emit('open');
  first.emit('message', closedMsg(0));
  mock.timers.tick(25000);
  assert.equal(first.terminated, false);
  mock.timers.tick(10000); // 35s không có message
  assert.equal(first.terminated, true);
  mock.timers.tick(2000); // backoff lần đầu <= 1s
  assert.equal(FakeWS.all.length, 2);
  s.stop();
  mock.timers.reset();
  mock.restoreAll();
});

test('Socket cũ bị thay thế đóng muộn không kích hoạt reconnect thừa; stop() thì dừng hẳn', () => {
  reset();
  quiet();
  const s = new MarketStream({}, { WS: FakeWS, fetch: async () => [] });
  s.connect();
  s.connect();
  assert.equal(FakeWS.all[0].terminated, true);
  assert.equal(s.attempt, 0);
  s.stop();
  FakeWS.all[1].emit('close');
  assert.equal(s.attempt, 0);
  assert.equal(s.status, 'stopped');
  mock.restoreAll();
});

test('Cooldown: 1 kèo 1 lúc trên mọi khung', () => {
  const g = new SignalGate({ cooldownMin: 30 });
  assert.equal(g.allow({}, 0), true);
  assert.equal(g.allow({}, 15 * 60e3), false); // 3m rồi 5m cùng nhịp giá
  assert.equal(g.allow({}, 30 * 60e3), true);
});
