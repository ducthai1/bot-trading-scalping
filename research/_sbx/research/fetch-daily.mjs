// Tải nến ngày + lịch sử funding (USDⓈ-M Futures) cho danh sách coin, từ 2019-09 tới nay.
// node _sbx/research/fetch-daily.mjs BTCUSDT,ETHUSDT > daily.json   (dừng ngay nếu 418/429)
const syms = process.argv[2].split(',');
const PACE = Number(process.env.PACE_MS) || 700;
const START = Date.UTC(2019, 8, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nReq = 0;
async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  nReq++;
  if (res.status === 418 || res.status === 429) {
    process.stderr.write(`STOP ${res.status} retry-after=${res.headers.get('retry-after')}\n`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(`${res.status} ${url} ${await res.text()}`);
  await sleep(PACE);
  return res.json();
}
const out = {};
const today = Math.floor(Date.now() / 86400e3) * 86400e3; // exclude today's open candle
for (const s of syms) {
  const k = [];
  for (let from = START; ; ) {
    const b = await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=1d&limit=1500&startTime=${from}&endTime=${today - 1}`);
    for (const r of b) k.push([r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
    if (b.length < 1500) break;
    from = b.at(-1)[0] + 86400e3;
  }
  const f = [];
  for (let from = START; ; ) {
    const b = await get(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&limit=1000&startTime=${from}`);
    for (const r of b) f.push([r.fundingTime, +r.fundingRate]);
    if (b.length < 1000) break;
    from = b.at(-1).fundingTime + 1;
  }
  out[s] = { k, f };
  process.stderr.write(`${s}: ${k.length} ngày từ ${new Date(k[0][0]).toISOString().slice(0, 10)}, ${f.length} lần funding\n`);
}
process.stderr.write(`requests=${nReq}\n`);
process.stdout.write(JSON.stringify(out));
