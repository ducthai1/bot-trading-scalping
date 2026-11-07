// Binance SPOT public market data (no API key). Uses data-api.binance.vision, the market-data-only host.
// Anti-ban rules: requests are serialized with a minimum gap; 418/429 block ALL requests until
// Retry-After (never retried early); network errors / 5xx retry with exponential backoff.
import { sleep } from './util.js';

const BASE = process.env.SWING_BINANCE_BASE || 'https://data-api.binance.vision';
const MIN_GAP_MS = 250;
const TIMEOUT_MS = 15000;

export class RateLimitError extends Error {}

export const netStats = { requests: 0, errors: 0, lastWeight: null, blockedUntil: 0, lastError: null };
let chain = Promise.resolve();
let lastAt = 0;

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export function get(pathAndQuery, { retries = 3 } = {}) {
  return enqueue(async () => {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() < netStats.blockedUntil) throw new RateLimitError(`Binance đang chặn tạm thời tới ${new Date(netStats.blockedUntil).toISOString()}`);
      const wait = lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      let res;
      try {
        res = await fetch(BASE + pathAndQuery, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (e) {
        netStats.errors++;
        netStats.lastError = e.message;
        if (attempt >= retries) throw new Error(`Không kết nối được Binance (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      netStats.requests++;
      netStats.lastWeight = res.headers.get('x-mbx-used-weight-1m');
      if (res.status === 418 || res.status === 429) {
        const sec = Number(res.headers.get('retry-after')) || 120;
        netStats.blockedUntil = Date.now() + sec * 1000;
        netStats.errors++;
        throw new RateLimitError(`Binance ${res.status} (rate limit/IP ban) — dừng mọi request ${sec}s`);
      }
      if (res.status >= 500 && attempt < retries) {
        netStats.errors++;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        netStats.errors++;
        throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return res.json();
    }
  });
}

const toKline = (r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6] });

export async function klines(symbol, interval, { startTime, endTime, limit = 1000 } = {}) {
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startTime != null) q.set('startTime', String(startTime));
  if (endTime != null) q.set('endTime', String(endTime));
  return (await get(`/api/v3/klines?${q}`)).map(toKline);
}

// All candles with open time in [startTime, endTime], paging forward.
export async function klinesRange(symbol, interval, startTime, endTime) {
  const out = [];
  let from = startTime;
  for (let guard = 0; guard < 50 && from <= endTime; guard++) {
    const batch = await klines(symbol, interval, { startTime: from, endTime, limit: 1000 });
    if (!batch.length) break;
    out.push(...batch);
    from = batch.at(-1).t + 1;
    if (batch.length < 1000) break;
  }
  return out;
}

// { SYMBOL: { status, step, minQty, minNotional, tick } }
export async function exchangeFilters(symbols) {
  const info = await get(`/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  const out = {};
  for (const s of info.symbols || []) {
    const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
    out[s.symbol] = {
      status: s.status,
      step: f.LOT_SIZE ? f.LOT_SIZE.stepSize : null,
      minQty: f.LOT_SIZE ? +f.LOT_SIZE.minQty : 0,
      minNotional: +(f.NOTIONAL?.minNotional ?? f.MIN_NOTIONAL?.minNotional ?? 0),
      tick: f.PRICE_FILTER ? f.PRICE_FILTER.tickSize : null,
    };
  }
  return out;
}

export async function tickerPrices(symbols) {
  const rows = await get(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
  return Object.fromEntries(rows.map((r) => [r.symbol, +r.price]));
}
