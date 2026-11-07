// Binance public klines (no API key). BTCUSDT only.
// Default source is USDⓈ-M Futures only: the live WebSocket streams futures candles, and spot
// trades ~30–50 giá away from futures (basis) — more than the whole 10–20 giá SL — so spot candles
// must never be mixed in. A geo-block (451/403) or an IP ban/rate-limit (418/429) blocks the source
// until Retry-After expires instead of retrying it.
// Opt into a fallback list with env BINANCE_SOURCE=futures,spot (or spot alone).
const SOURCES = {
  futures: { name: 'futures', url: 'https://fapi.binance.com/fapi/v1/klines' },
  spot: { name: 'spot', url: 'https://data-api.binance.vision/api/v3/klines' },
};
const order = (process.env.BINANCE_SOURCE || 'futures').split(',').map((s) => SOURCES[s.trim()]).filter(Boolean);
const blockedUntil = {}; // source name -> epoch ms
const TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS) || 10000;
const GEO_RETRY_MS = 6 * 3600 * 1000; // re-try a geo-blocked source every 6h
let lastOk = order[0].name;

export const dataSource = () => lastOk;

async function request(src, params) {
  const url = new URL(src.url);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export async function fetchKlines(interval, limit = 300, { startTime, endTime } = {}) {
  const params = { symbol: 'BTCUSDT', interval, limit, startTime, endTime };
  const errors = [];
  for (const src of order) {
    const until = blockedUntil[src.name] || 0;
    if (Date.now() < until) {
      errors.push(`${src.name} tạm khóa tới ${new Date(until).toISOString()}`);
      continue;
    }
    let res;
    try {
      res = await request(src, params);
    } catch (e) {
      errors.push(`${src.name} không phản hồi (${e.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS}ms` : e.message})`);
      continue;
    }
    if (res.status === 418 || res.status === 429) {
      // 429 = vượt rate limit, 418 = IP bị ban. Tôn trọng Retry-After, không gọi lại nguồn này trước hạn.
      const retry = Number(res.headers.get('retry-after')) || 60;
      blockedUntil[src.name] = Date.now() + retry * 1000;
      errors.push(`${src.name} ${res.status}: IP bị rate-limit/ban ~${(retry / 3600).toFixed(1)}h`);
      console.warn(`⚠️ Binance ${errors.at(-1)}`);
      continue;
    }
    if (res.status === 451 || res.status === 403) {
      blockedUntil[src.name] = Date.now() + GEO_RETRY_MS;
      errors.push(`${src.name} ${res.status}: IP server bị chặn theo khu vực`);
      console.warn(`⚠️ Binance ${errors.at(-1)}`);
      continue;
    }
    if (!res.ok) throw new Error(`Binance ${src.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    lastOk = src.name;
    const now = Date.now();
    return (await res.json())
      .filter((r) => r[6] < now) // closed candles only
      .map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6] }));
  }
  throw new Error(`Binance: mọi nguồn đều lỗi — ${errors.join(' | ')}`);
}

export async function fetchRange(interval, startTime, endTime) {
  const out = [];
  let from = startTime;
  const limit = 1000; // max chung của futures (1500) và spot (1000)
  while (from < endTime) {
    const batch = await fetchKlines(interval, limit, { startTime: from, endTime });
    if (!batch.length) break;
    out.push(...batch);
    from = batch[batch.length - 1].t + 1;
    if (batch.length < limit) break;
  }
  return out;
}
