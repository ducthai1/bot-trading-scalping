// Tải nến 5m USDⓈ-M Futures cho 1 symbol, N ngày. Ghi JSON ra stdout, log ra stderr.
// Dừng ngay (không thử lại) nếu Binance trả 418/429 — tôn trọng rate limit.
// node _sbx/research/fetch5m.mjs SOLUSDT 730 > SOLUSDT_5m.json
const [SYM, DAYS = '730'] = process.argv.slice(2);
const PACE = Number(process.env.PACE_MS) || 600;
const STEP = 300e3;
const end = Math.floor(Date.now() / STEP) * STEP; // exclude the open candle
const start = end - Number(DAYS) * 86400e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
let from = start;
let n = 0;
while (from < end) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYM}&interval=5m&limit=1000&startTime=${from}&endTime=${end - 1}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  n++;
  if (res.status === 418 || res.status === 429) {
    process.stderr.write(`STOP ${res.status} retry-after=${res.headers.get('retry-after')}\n`);
    process.exit(2);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const batch = await res.json();
  if (!batch.length) break;
  for (const r of batch) rows.push([r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
  from = batch.at(-1)[0] + STEP;
  if (n % 25 === 0) process.stderr.write(`${SYM} req=${n} rows=${rows.length} weight1m=${res.headers.get('x-mbx-used-weight-1m')}\n`);
  await sleep(PACE);
}
let gaps = 0;
for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] !== STEP) gaps++;
process.stderr.write(`${SYM} DONE req=${n} rows=${rows.length} gaps=${gaps} from=${new Date(rows[0][0]).toISOString()} to=${new Date(rows.at(-1)[0]).toISOString()}\n`);
process.stdout.write(JSON.stringify({ symbol: SYM, tf: '5m', rows }));
