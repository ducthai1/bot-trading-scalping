// Binance USDⓈ-M Futures public klines (no API key needed). BTCUSDT only.
const BASE = 'https://fapi.binance.com/fapi/v1/klines';

export async function fetchKlines(interval, limit = 300, { startTime, endTime } = {}) {
  const url = new URL(BASE);
  url.searchParams.set('symbol', 'BTCUSDT');
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  if (startTime) url.searchParams.set('startTime', String(startTime));
  if (endTime) url.searchParams.set('endTime', String(endTime));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const now = Date.now();
  return (await res.json())
    .filter((r) => r[6] < now) // closed candles only
    .map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6] }));
}

export async function fetchRange(interval, startTime, endTime) {
  const out = [];
  let from = startTime;
  while (from < endTime) {
    const batch = await fetchKlines(interval, 1500, { startTime: from, endTime });
    if (!batch.length) break;
    out.push(...batch);
    from = batch[batch.length - 1].t + 1;
    if (batch.length < 1500) break;
  }
  return out;
}
