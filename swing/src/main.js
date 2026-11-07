#!/usr/bin/env node
// Swing bot R3 + Breakout — Binance SPOT, daily candles, ALERTS ONLY (never places orders).
//   node swing/src/main.js          run forever (use pm2)       --dry   no Telegram, log only
//   node swing/src/main.js --once   run the due daily job once, then exit (no realtime feed)
//
// Data flow
//   07:02 VN (00:02 UTC) daily job : REST daily candles -> close yesterday (signals) -> open today
//   realtime (WebSocket)           : closed 1-minute bars -> SL/TP + MFE/MAE for real & hypothetical trades
//   gap-fill job (hourly)          : REST 1m/1h bars for any minute the socket missed (0 requests when healthy)
// Engine order is always openDay(d) -> intraday bars of d -> closeDay(d): live bars of a day that has not been
// opened yet wait in a queue, and missing minutes are fetched before newer bars are applied.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadConfig, validate } from './config.js';
import { createStore } from './store.js';
import { createTelegram } from './telegram.js';
import { buildSeries, trendUp } from './strategy.js';
import { newState, openDay, intraday, closeDay, hasHolder, intradayNeed } from './engine.js';
import { get as binanceGet, klines, klinesRange, exchangeFilters, tickerPrices, netStats, RateLimitError } from './binance.js';
import { LiveFeed } from './live.js';
import { dailyDue, intradayDue, nextDailyAt } from './schedule.js';
import { dailyMessage, intradayMessage, signalLogLines, weeklyMessage } from './notify.js';
import { persistEvents, loadHistory } from './history.js';
import { buildReport } from './report.js';
import { watchlist } from './watch.js';
import { startServer } from './server.js';
import { DAY, HOUR, MIN, dayStart, fmtVN, isoDay } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(ROOT, '.env'));
loadEnv(path.join(ROOT, '..', '.env'));
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const ONCE = args.has('--once');

const cfg = loadConfig(ROOT);
const store = createStore(cfg.dataDir);
// A Binance ban (418/429) survives restarts: a pm2 restart loop must not hammer the API again.
try {
  const ban = JSON.parse(readFileSync(store.file('net.json'), 'utf8'));
  if (ban.blockedUntil > Date.now()) netStats.blockedUntil = ban.blockedUntil;
} catch {
  /* no previous ban */
}
const status = { mode: DRY ? 'dry' : 'live-alerts', pid: process.pid, startedAt: Date.now(), busy: null, lastRun: {}, lastDailyOk: null, lastError: null, nextRetryAt: 0, prices: {}, pricesAt: null, btcOk: null, lastActions: null, live: null, queue: 0 };

function log(level, msg, extra) {
  const line = `[${fmtVN(Date.now())}] ${msg}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  try {
    store.append('events.jsonl', [{ at: Date.now(), level, msg, ...(extra ? { extra } : {}) }]);
  } catch {
    /* logging must never crash the bot */
  }
}

if (!store.acquireLock()) {
  console.error(`❌ Đã có một bot swing khác đang chạy với thư mục dữ liệu ${cfg.dataDir} (file bot.lock). Dừng.`);
  process.exit(1);
}
const warn = validate(cfg);
if (warn) log('warn', `⚠️ ${warn}`);

const tg = createTelegram({ token: process.env.SWING_TELEGRAM_TOKEN || process.env.TELEGRAM_TOKEN, chatId: process.env.SWING_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID, dry: DRY, log: console });
if (!tg.enabled && !DRY) log('warn', 'Chưa cấu hình TELEGRAM_TOKEN / TELEGRAM_CHAT_ID — chỉ ghi log và dashboard.');

let state = store.loadState();
if (!state) {
  const today = dayStart(Date.now());
  state = newState(cfg, today - DAY); // first job closes yesterday (signals) and opens today
  state.createdAt = Date.now();
  store.saveState(state);
  log('info', `Khởi tạo sổ giả lập: vốn ${cfg.capital}$, ${cfg.coins.length} coin.`);
} else if (state.capital !== cfg.capital) {
  log('warn', `config.capital (${cfg.capital}) khác vốn trong sổ (${state.capital}). Sổ giữ nguyên; muốn bắt đầu lại hãy xoá thư mục dữ liệu.`);
}

// Closed daily candles of the last job, kept for the realtime watchlist (also on disk for restarts).
const dailyCache = new Map();
try {
  for (const [s, rows] of Object.entries(JSON.parse(readFileSync(store.file('daily-cache.json'), 'utf8')))) dailyCache.set(s, rows);
} catch {
  /* filled by the first daily job */
}

// ------------------------------------------------------------------ data
let filterCache = { at: 0, data: {} };
async function getFilters() {
  if (Date.now() - filterCache.at < 12 * HOUR) return filterCache.data;
  let data = {};
  try {
    data = await exchangeFilters(cfg.coins);
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // one delisted / renamed symbol makes the batch call fail: fall back to one by one
    for (const s of cfg.coins) {
      try {
        Object.assign(data, await exchangeFilters([s]));
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        log('warn', `Không lấy được thông tin ${s} (có thể đã huỷ niêm yết): ${err.message}`);
      }
    }
  }
  filterCache = { at: Date.now(), data };
  return data;
}

async function getPrices(symbols) {
  if (!symbols.length) return {};
  try {
    return await tickerPrices(symbols);
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    const out = {};
    for (const s of symbols) {
      try {
        Object.assign(out, await tickerPrices([s]));
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
      }
    }
    return out;
  }
}

// Intraday bars [from, to] from REST: 1-minute bars for short gaps, hourly bars for long outages.
async function fetchBars(sym, from, to) {
  const interval = to - from <= 2 * DAY ? '1m' : '1h';
  const step = interval === '1m' ? MIN : HOUR;
  const now = Date.now();
  return (await klinesRange(sym, interval, Math.floor(from / step) * step, to)).filter((b) => b.ct < now && b.ct >= from);
}

const barsOfDay = (bars, d) => (bars || []).filter((b) => b.t >= d && b.t < d + DAY);

function intradayLoader(now) {
  const cache = {};
  return async (s) => {
    const need = intradayNeed(state, s);
    if (need == null) return [];
    if (!cache[s] || cache[s].from > need) cache[s] = { from: need, bars: await fetchBars(s, need, now) };
    return cache[s].bars;
  };
}

function makeCtx({ series, forming, filters, prices, now }) {
  const today = dayStart(now);
  const symbols = cfg.coins.filter((s) => series.has(s));
  const openPrice = (s, t) => {
    if (t === today) return forming[s]?.o ?? null;
    const S = series.get(s);
    const i = S?.idx.get(t);
    return i == null ? null : S.o[i];
  };
  const isLate = (t) => t < today || now - t > cfg.maxEntryDelayHours * HOUR;
  const price = (s, t, side) => {
    const o = openPrice(s, t);
    if (t < today) return side === 'sell' && o != null ? { px: o, time: t, late: true } : null; // catch-up
    if (now - t <= cfg.onTimeMinutes * MIN) {
      if (o != null) return { px: o, time: t, late: false };
      return prices[s] != null ? { px: prices[s], time: now, late: false } : null; // today's candle not published yet
    }
    if (side === 'buy' && isLate(t)) return null;
    const p = prices[s] ?? o;
    return p != null ? { px: p, time: now, late: true } : null;
  };
  return { cfg, symbols, series: (s) => series.get(s), filters: (s) => filters[s] ?? null, openPrice, price, isLate };
}

// Shared post-processing for every job: persist, readable log lines, Telegram for real closes.
async function publish(events, { alertCloses = true } = {}) {
  if (!events.length) return;
  persistEvents(store, events);
  for (const line of signalLogLines(events)) log('info', line);
  const realHits = events.filter((e) => e.type === 'trade_close' && (e.trade.reason === 'SL' || e.trade.reason === 'TP')).map((e) => e.trade);
  if (alertCloses && realHits.length) {
    status.lastActions = { at: Date.now(), events: [...(status.lastActions?.events || []), ...events.filter((e) => e.type === 'trade_close')] };
    await tg.send(intradayMessage({ closes: realHits, filters: filterCache.data }));
  }
}

// ------------------------------------------------------------------ jobs
async function dailyJob() {
  const local = Date.now();
  const serverTime = (await binanceGet('/api/v3/time')).serverTime;
  if (Math.abs(serverTime - local) > MIN) log('warn', `⚠️ Đồng hồ máy lệch ${Math.round((local - serverTime) / 1000)}s so với Binance — dùng giờ Binance. Nên bật đồng bộ giờ (NTP).`);
  const now = serverTime;
  const today = dayStart(now);
  const filters = await getFilters();
  const series = new Map();
  const closedRows = {};
  const forming = {};
  const missing = [];
  for (const s of cfg.coins) {
    try {
      const rows = await klines(s, '1d', { limit: 420 });
      const closed = rows.filter((k) => k.ct < now);
      const f = rows.find((k) => k.t === today);
      if (f) forming[s] = f;
      for (let i = 1; i < closed.length; i++) if (closed[i].t - closed[i - 1].t !== DAY) log('warn', `${s}: dữ liệu ngày bị thủng quanh ${isoDay(closed[i - 1].t)}`);
      if (closed.length) {
        series.set(s, buildSeries(closed));
        closedRows[s] = closed;
      }
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      missing.push(s);
      log('warn', `${s}: không tải được nến ngày (${e.message}) — bỏ qua coin này hôm nay`);
    }
  }
  // Too much missing data (network trouble) must not "close" a day: its signals would be lost forever.
  if (missing.length > cfg.coins.length * 0.2 || (cfg.btcFilter && !series.has('BTCUSDT'))) {
    throw new Error(`Thiếu dữ liệu ${missing.length}/${cfg.coins.length} coin${series.has('BTCUSDT') ? '' : ' (kể cả BTC)'} — chưa chốt ngày, sẽ thử lại`);
  }
  for (const [s, f] of Object.entries(forming)) if (feed && feed.daily[s]?.t !== today) feed.daily[s] = f; // seed the watchlist until the socket sends one
  const loadIntra = intradayLoader(now);
  const prices = feed?.healthy() ? { ...feed.prices } : await getPrices(cfg.coins.filter((s) => series.has(s)));
  status.prices = prices;
  status.pricesAt = now;
  const ctx = makeCtx({ series, forming, filters, prices, now });

  const events = [];
  const startDay = Math.min(state.lastOpenedDay, state.lastClosedDay) + DAY;
  const catchUpDays = Math.max(0, Math.round((today - DAY - state.lastClosedDay) / DAY) - 1);
  for (let d = startDay; d < today; d += DAY) {
    if (d > state.lastOpenedDay) events.push(...openDay(state, d, ctx));
    for (const s of cfg.coins) {
      const need = intradayNeed(state, s); // skip symbols whose holders were already processed live past day d
      if (need != null && need < d + DAY) events.push(...intraday(state, s, barsOfDay(await loadIntra(s), d), ctx));
    }
    if (d > state.lastClosedDay) events.push(...closeDay(state, d, ctx));
  }
  if (today > state.lastOpenedDay) events.push(...openDay(state, today, ctx));
  for (const p of state.positions) if (prices[p.symbol] != null) p.lastPx = prices[p.symbol];

  const btc = series.get('BTCUSDT');
  status.btcOk = btc ? trendUp(btc, btc.c.length - 1) : false;
  persistEvents(store, events);
  state.lastJob = { at: now, day: today, catchUpDays, missing, actions: events.filter((e) => e.type === 'trade_open' || e.type === 'trade_close').length };
  store.saveState(state);
  for (const [s, rows] of Object.entries(closedRows)) dailyCache.set(s, rows.slice(-420));
  store.writeAtomic('daily-cache.json', JSON.stringify(Object.fromEntries(dailyCache)));
  store.rotate('events.jsonl');
  status.lastActions = { at: now, events: events.filter((e) => e.type === 'trade_open' || e.type === 'trade_close') };
  watchCache = null;

  const n = (t) => events.filter((e) => e.type === t).length;
  log('info', `✅ Job ngày ${isoDay(today)}: ${n('signal')} tín hiệu, ${n('trade_open')} mua, ${n('trade_close')} đóng, ${n('signal_result')} kết quả kiểm chứng, vốn ${state.equity.toFixed(2)}$${catchUpDays ? `, chạy bù ${catchUpDays} ngày` : ''}${missing.length ? `, thiếu dữ liệu: ${missing.join(',')}` : ''}`);
  for (const line of signalLogLines(events)) log('info', line);
  await tg.send(dailyMessage({ events, state, cfg, today, now, filters, btcOk: status.btcOk, catchUpDays, dry: DRY }));
  if (new Date(today).getUTCDay() === 1 && (state.lastWeekly ?? 0) < today) {
    state.lastWeekly = today;
    store.saveState(state);
    await tg.send(weeklyMessage(buildReport({ cfg, state, history: loadHistory(store), status, now })));
  }
}

// Safety net for minutes the WebSocket missed (sleep, outage). Does nothing while the socket is healthy.
async function gapFillJob() {
  const now = Date.now();
  if (!feed?.healthy()) {
    const held = [...new Set(state.positions.map((p) => p.symbol))];
    if (held.length) {
      status.prices = { ...status.prices, ...(await getPrices(held)) };
      status.pricesAt = now;
    }
  }
  const events = [];
  for (const s of cfg.coins) {
    const need = intradayNeed(state, s);
    if (need == null || need > now - 3 * MIN) continue;
    const bars = (await fetchBars(s, need, now)).filter((b) => dayStart(b.t) <= state.lastOpenedDay);
    events.push(...intraday(state, s, bars, { cfg }));
  }
  for (const p of state.positions) if (status.prices[p.symbol] != null) p.lastPx = status.prices[p.symbol];
  await publish(events);
  store.saveState(state);
}

// ------------------------------------------------------------------ realtime
const liveQueue = [];
let lastLiveSave = 0;
let watchCache = null;

function onLiveBar(sym, bar) {
  if (!hasHolder(state, sym)) return;
  liveQueue.push([sym, bar]);
  if (liveQueue.length > 200000) liveQueue.splice(0, liveQueue.length - 200000); // REST gap-fill covers the rest
  status.queue = liveQueue.length;
  if (!status.busy) runJob('realtime', processLive);
}

async function processLive() {
  // Only bars of days the daily job has already opened; later ones wait for openDay.
  const ready = [], wait = [];
  for (const item of liveQueue.splice(0)) (dayStart(item[1].t) <= state.lastOpenedDay ? ready : wait).push(item);
  liveQueue.push(...wait);
  status.queue = liveQueue.length;
  const bySym = new Map();
  for (const [s, b] of ready) (bySym.get(s) || bySym.set(s, []).get(s)).push(b);
  const events = [];
  for (const [s, bars] of bySym) {
    bars.sort((a, b) => a.t - b.t);
    const need = intradayNeed(state, s);
    if (need == null) continue;
    let all = bars;
    if (bars[0].t > need) all = [...(await fetchBars(s, need, bars[0].t - 1)), ...bars]; // missed minutes first
    events.push(...intraday(state, s, all, { cfg }));
  }
  for (const p of state.positions) if (feed?.prices[p.symbol] != null) p.lastPx = feed.prices[p.symbol];
  await publish(events);
  if (events.length || Date.now() - lastLiveSave > 15 * MIN) {
    store.saveState(state);
    lastLiveSave = Date.now();
  }
}

// ------------------------------------------------------------------ scheduler
let lastFailAlert = 0;
async function runJob(name, fn) {
  if (status.busy) return;
  status.busy = name;
  const snapshot = structuredClone(state); // a failed job must leave the books exactly as they were
  try {
    await fn();
    if (name === 'daily') status.lastDailyOk = Date.now();
    if (name !== 'realtime') {
      status.lastError = null;
      status.nextRetryAt = 0;
    }
  } catch (e) {
    state = snapshot;
    if (e instanceof RateLimitError) store.writeAtomic('net.json', JSON.stringify({ blockedUntil: netStats.blockedUntil, at: Date.now(), message: e.message }));
    const wait = e instanceof RateLimitError ? Math.max(netStats.blockedUntil - Date.now(), 0) + MIN : cfg.schedule.retryMinutes * MIN;
    status.lastError = { at: Date.now(), job: name, message: e.message };
    status.nextRetryAt = Date.now() + wait;
    log('error', `❌ Job ${name} lỗi: ${e.message} — thử lại sau ${Math.round(wait / MIN)} phút`);
    if (Date.now() - lastFailAlert > 6 * HOUR) {
      lastFailAlert = Date.now();
      await tg.send(`❌ <b>Swing bot lỗi</b> (${name}): ${e.message}\nBot sẽ tự thử lại sau ${Math.round(wait / MIN)} phút.`);
    }
  } finally {
    status.lastRun[name] = Date.now();
    status.busy = null;
  }
  if (liveQueue.length && name !== 'realtime') setImmediate(() => runJob('realtime', processLive));
}

async function tick() {
  if (status.busy || Date.now() < status.nextRetryAt) return;
  const now = Date.now();
  if (dailyDue(now, state, cfg)) await runJob('daily', dailyJob);
  else if (intradayDue(now, status.lastRun.gapfill, cfg)) await runJob('gapfill', gapFillJob);
  else if (liveQueue.length) await runJob('realtime', processLive);
}

// ------------------------------------------------------------------ lifecycle
let timer = null, server = null, stopping = false, feed = null;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  feed?.stop();
  if (server) server.close();
  const until = Date.now() + 10000;
  while (status.busy && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  try {
    store.saveState(state);
  } catch {
    /* best effort */
  }
  store.releaseLock();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('unhandledRejection', (e) => log('error', `unhandledRejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => {
  log('error', `uncaughtException: ${e?.stack || e}`);
  store.releaseLock();
  process.exit(1); // pm2 restarts; state on disk is consistent (atomic writes)
});

log('info', `🚀 Swing bot khởi động (${status.mode}), dữ liệu: ${cfg.dataDir}, job ngày kế tiếp: ${fmtVN(nextDailyAt(Date.now(), cfg))}`);
if (ONCE) {
  if (dailyDue(Date.now(), state, cfg)) await runJob('daily', dailyJob);
  else log('info', 'Job ngày đã chạy cho hôm nay — không có gì để làm.');
  await shutdown(status.lastError ? 1 : 0);
} else {
  feed = new LiveFeed({ symbols: cfg.coins, onBar: onLiveBar, log: { log: (m) => log('info', m), warn: (m) => log('warn', m) } });
  const liveInfo = () => ({ status: feed.status, healthy: feed.healthy(), ...feed.stats });
  const getWatch = () => {
    if (!watchCache || Date.now() - watchCache.at > 30e3) watchCache = watchlist({ cfg, cache: dailyCache, liveDaily: feed.daily, prices: feed.prices, now: Date.now() });
    return watchCache;
  };
  Object.defineProperty(status, 'live', { get: liveInfo, enumerable: true });
  Object.defineProperty(status, 'prices', { get: () => ({ ...status._prices, ...feed.prices }), set: (v) => (status._prices = v), enumerable: true });
  const triggers = {
    // "Chạy ngay" on the dashboard runs whichever job is due (never a second daily run for the same day).
    due: () => (dailyDue(Date.now(), state, cfg) ? runJob('daily', dailyJob) : runJob('gapfill', gapFillJob)),
    resetBreaker: () => {
      state.breaker = null;
      state.peak = state.equity; // otherwise it would trip again immediately
      store.saveState(state);
      return { peak: state.peak };
    },
  };
  server = startServer({ cfg, store, getState: () => state, status, tg, triggers, log, nextDailyAt: () => nextDailyAt(Date.now(), cfg), netStats, getWatch, getLive: () => ({ feed: liveInfo(), prices: feed.prices }) });
  feed.start();
  timer = setInterval(() => tick().catch((e) => log('error', `tick: ${e.message}`)), 30000);
  tick().catch((e) => log('error', `tick: ${e.message}`));
}
