// In chi tiết 1 tín hiệu trong backtest: nến, EMA8/13/21, nhịp hồi, nến xác nhận, kết cục.
import { readFileSync } from 'node:fs';
import { evaluate, trendOf } from '/app/src/strategy.js';
import { ema } from '/app/src/indicators.js';
const D = JSON.parse(readFileSync('/app/_sbx/data/klines180.json', 'utf8'));
const cfg = JSON.parse(readFileSync('/app/config.json', 'utf8'));
const F = D.futures, WIN = 300, T = Date.parse(process.argv[2]);
const cs3 = F['3m'];
const i = cs3.findIndex((k) => k.ct + 1 === T);
const upto = (arr) => arr.filter((k) => k.ct < T).slice(-WIN);
const candles = cs3.slice(i - WIN + 1, i + 1), h1 = upto(F['1h']), m15 = upto(F['15m']);
const r = evaluate({ h1, m15, candles, tf: '3m', cfg });
const c = candles.map((k) => k.c), e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21);
const n = candles.length - 1, f = (x) => x.toFixed(1).padStart(8);
console.log(`Đại cục: 1H=${trendOf(h1, cfg)}, 15m=${trendOf(m15, cfg)}  ->  ${r.signal ? 'TÍN HIỆU ' + r.signal.side : r.reason}`);
console.log('giờ UTC   mở      cao      thấp     đóng  |   EMA8    EMA13    EMA21 | ghi chú');
for (let j = n - 9; j <= n; j++) {
  const k = candles[j], s = r.signal;
  let note = '';
  if (s && j === n - s.pbCount - 1) note = '← đỉnh trước nhịp hồi (TP1)';
  else if (s && j > n - s.pbCount - 1 && j < n) note = `nhịp hồi #${j - (n - s.pbCount - 1)}`;
  if (j === n) {
    const range = k.h - k.l;
    note = `NẾN XÁC NHẬN: ${k.c > k.o ? 'xanh' : 'đỏ'}, thân ${(((k.c - k.o) / range) * 100).toFixed(0)}% biên độ, râu dưới ${(((Math.min(k.o, k.c) - k.l) / range) * 100).toFixed(0)}% | thấp ${k.l <= e13[j] ? '≤' : '>'} EMA13, đóng ${k.c > e21[j] ? '>' : '≤'} EMA21`;
  }
  console.log(`${new Date(k.t).toISOString().slice(11, 16)} ${f(k.o)} ${f(k.h)} ${f(k.l)} ${f(k.c)} | ${f(e8[j])} ${f(e13[j])} ${f(e21[j])} | ${note}`);
}
if (r.signal) {
  const s = r.signal;
  console.log(`Entry ${s.entry} | SL ${s.sl} (${(s.entry - s.sl).toFixed(1)} giá dưới râu) | TP1 ${s.tp1} | TP2 ${s.tp2}`);
  for (let j = i + 1; j < cs3.length; j++) {
    const k = cs3[j];
    if (k.l <= s.sl) { console.log(`Kết cục: chạm SL lúc ${new Date(k.t).toISOString().slice(11, 16)} (sau ${j - i} nến 3m), giá thấp ${k.l}`); break; }
    if (k.h >= s.tp1) { console.log(`Kết cục: chạm TP1 lúc ${new Date(k.t).toISOString().slice(11, 16)} (sau ${j - i} nến 3m)`); break; }
  }
}
