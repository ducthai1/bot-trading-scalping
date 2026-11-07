// Tải dữ liệu 1 lần để replay offline: klines futures (+ spot 3m để đo basis) + filter BTCUSDT.
// node _sbx/fetch-data.mjs <days>  > data.json     (log ra stderr)
const DAYS = Number(process.argv[2]) || 30;
const MS = { '1h': 3600e3, '15m': 900e3, '5m': 300e3, '3m': 180e3 };
const WARM = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nReq = 0;

async function get(url) {
  nReq++;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const w = res.headers.get('x-mbx-used-weight-1m');
  if (!res.ok) throw new Error(`${res.status} ${url} ${(await res.text()).slice(0, 200)}`);
  if (w) process.stderr.write(`  weight-1m=${w}\n`);
  await sleep(Number(process.env.PACE_MS) || 300);
  return res.json();
}

async function range(base, tf, start, end) {
  const out = [];
  let from = start;
  while (from < end) {
    const rows = await get(`${base}?symbol=BTCUSDT&interval=${tf}&limit=1000&startTime=${from}&endTime=${end}`);
    if (!rows.length) break;
    for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ct: r[6] });
    from = rows.at(-1)[0] + 1;
    if (rows.length < 1000) break;
  }
  return out.filter((k) => k.ct < Date.now());
}

const end = Date.now();
const start = end - DAYS * 86400e3;
const data = { days: DAYS, end, futures: {}, spot3m: [], filters: null };
for (const tf of Object.keys(MS)) {
  data.futures[tf] = await range('https://fapi.binance.com/fapi/v1/klines', tf, start - WARM * MS[tf], end);
  process.stderr.write(`futures ${tf}: ${data.futures[tf].length}\n`);
}
data.spot3m = await range('https://data-api.binance.vision/api/v3/klines', '3m', end - 2 * 86400e3, end);
process.stderr.write(`spot 3m: ${data.spot3m.length}\n`);
const info = await get('https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=BTCUSDT').catch(() => null);
const sym = info?.symbols?.find((s) => s.symbol === 'BTCUSDT');
data.filters = sym?.filters?.filter((f) => ['LOT_SIZE', 'MARKET_LOT_SIZE', 'MIN_NOTIONAL', 'PRICE_FILTER'].includes(f.filterType)) || null;
process.stderr.write(`requests: ${nReq}\n`);
process.stdout.write(JSON.stringify(data));
