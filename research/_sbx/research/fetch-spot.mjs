// Tải nến SPOT (data-api.binance.vision, chỉ dữ liệu thị trường) 4h + 1d từ 2018 cho danh sách coin.
// node _sbx/research/fetch-spot.mjs BTCUSDT,ETHUSDT > spot.json   (dừng ngay nếu 418/429)
const syms = process.argv[2].split(',');
const PACE = Number(process.env.PACE_MS) || 400;
const START = Date.UTC(2018, 0, 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nReq = 0;
async function klines(sym, interval, stepMs) {
  const end = Math.floor(Date.now() / stepMs) * stepMs; // drop the open candle
  const out = [];
  for (let from = START; from < end; ) {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${interval}&limit=1000&startTime=${from}&endTime=${end - 1}`, { signal: AbortSignal.timeout(20000) });
    nReq++;
    if (res.status === 418 || res.status === 429) {
      process.stderr.write(`STOP ${res.status} retry-after=${res.headers.get('retry-after')}\n`);
      process.exit(2);
    }
    if (res.status === 400) return null; // symbol không tồn tại / đã huỷ niêm yết
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const b = await res.json();
    await sleep(PACE);
    if (!b.length) break;
    for (const r of b) out.push([r[0], +r[1], +r[2], +r[3], +r[4], +r[5]]);
    from = b.at(-1)[0] + stepMs;
  }
  return out;
}
const data = {};
for (const s of syms) {
  const d1 = await klines(s, '1d', 86400e3);
  if (!d1 || !d1.length || Date.now() - d1.at(-1)[0] > 5 * 86400e3) {
    process.stderr.write(`${s}: bỏ qua (không có dữ liệu hoặc đã ngừng giao dịch)\n`);
    continue;
  }
  data[s] = { '4h': await klines(s, '4h', 4 * 3600e3), '1d': d1 };
  const d = data[s]['1d'];
  process.stderr.write(`${s}: 4h=${data[s]['4h'].length} 1d=${d.length} từ ${new Date(d[0][0]).toISOString().slice(0, 10)}\n`);
}
process.stderr.write(`requests=${nReq}\n`);
process.stdout.write(JSON.stringify(data));
