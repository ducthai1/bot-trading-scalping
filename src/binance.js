// Binance public klines (no API key). BTCUSDT only.
// Sources are tried in order; a geo-block (451/403) moves to the next one and is remembered.
//   1. USDⓈ-M Futures  fapi.binance.com          — blocked from US IPs (e.g. Render Oregon/Ohio/Virginia)
//   2. Spot market-data data-api.binance.vision    — public mirror, fallback only (spot price ≠ futures by the basis)
// Override with env BINANCE_SOURCE=futures|spot to pin one source.
const SOURCES = {
  futures: { name: 'futures', url: 'https://fapi.binance.com/fapi/v1/klines' },
  spot: { name: 'spot', url: 'https://data-api.binance.vision/api/v3/klines' },
};
const order = process.env.BINANCE_SOURCE ? [SOURCES[process.env.BINANCE_SOURCE]] : [SOURCES.futures, SOURCES.spot];
let active = 0;
let bannedUntil = 0;
const TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS) || 10000;

export const dataSource = () => order[active].name;

async function request(src, params) {
  const url = new URL(src.url);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

export async function fetchKlines(interval, limit = 300, { startTime, endTime } = {}) {
  if (Date.now() < bannedUntil) {
    throw new Error(`Binance rate-limit: tạm dừng tới ${new Date(bannedUntil).toISOString()}`);
  }
  const params = { symbol: 'BTCUSDT', interval, limit, startTime, endTime };
  let lastErr;
  for (let i = active; i < order.length; i++) {
    let res;
    try {
      res = await request(order[i], params);
    } catch (e) {
      lastErr = new Error(`Binance ${order[i].name} không phản hồi (${e.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS}ms` : e.message})`);
      continue;
    }
    if (res.status === 429 || res.status === 418) {
      // 429 = vượt rate limit, 418 = IP bị ban tạm thời. Tôn trọng Retry-After để không bị ban lâu hơn.
      const retry = Number(res.headers.get('retry-after')) || 60;
      bannedUntil = Date.now() + retry * 1000;
      throw new Error(`Binance ${res.status}: rate-limit, chờ ${retry}s`);
    }
    if (res.status === 451 || res.status === 403) {
      lastErr = new Error(`Binance ${order[i].name} ${res.status}: IP server bị chặn theo khu vực`);
      if (i + 1 < order.length) {
        console.warn(`⚠️ ${lastErr.message} → chuyển sang nguồn ${order[i + 1].name}`);
        active = i + 1;
      }
      continue;
    }
    if (!res.ok) throw new Error(`Binance ${order[i].name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const now = Date.now();
    return (await res.json())
      .filter((r) => r[6] < now) // closed candles only
      .map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6] }));
  }
  throw lastErr;
}

export async function fetchRange(interval, startTime, endTime) {
  const out = [];
  let from = startTime;
  const limit = 1000; // max chung của cả futures (1500) và spot (1000)
  while (from < endTime) {
    const batch = await fetchKlines(interval, limit, { startTime: from, endTime });
    if (!batch.length) break;
    out.push(...batch);
    from = batch[batch.length - 1].t + 1;
    if (batch.length < limit) break;
  }
  return out;
}
