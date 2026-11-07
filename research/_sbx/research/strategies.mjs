// 3 chiến lược ứng viên. Mỗi hàm nhận ctx (dữ liệu 1 coin) + biến thể, trả về danh sách lệnh chờ xử lý.
import { ema, sma, stdev, atr, adx, lastClosed, MIN } from './lib.mjs';

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A — Theo xu hướng khung lớn, vào ở nhịp hồi về EMA20 khung 15m.
//   Xu hướng: '1h' = EMA50>EMA200 & giá>EMA50 (1h) | '4h' = giá>EMA50 & EMA50 đang dốc lên (4h)
//   Vào: nến 15m chạm EMA20 rồi đóng lại trên EMA20, nến xanh -> Market ở nến kế tiếp
//   SL: đáy 5 nến 15m - 0.25 ATR (bỏ nếu SL < 0.5 ATR hoặc > 3 ATR)
//   Thoát: TP 2R | 3R | dời SL theo giá 3 ATR. Tối đa 2 ngày (3 ngày với dời SL).
export function stratA(ctx, v) {
  const { m5, idx, c15, c1h, c4h } = ctx;
  const e20 = ema(c15.map((k) => k.c), 20), a15 = atr(c15, 14);
  const e50h = ema(c1h.map((k) => k.c), 50), e200h = ema(c1h.map((k) => k.c), 200);
  const e50q = ema(c4h.map((k) => k.c), 50);
  const at1h = lastClosed(c1h), at4h = lastClosed(c4h);
  const orders = [];
  for (let j = 5; j < c15.length; j++) {
    const T = c15[j].ct + 1;
    const a = idx.get(T);
    if (a == null) continue;
    let up, down;
    if (v.trend === '1h') {
      const h = at1h(T);
      if (h < 200) continue;
      up = e50h[h] > e200h[h] && c1h[h].c > e50h[h];
      down = e50h[h] < e200h[h] && c1h[h].c < e50h[h];
    } else {
      const q = at4h(T);
      if (q < 53) continue;
      up = c4h[q].c > e50q[q] && e50q[q] > e50q[q - 3];
      down = c4h[q].c < e50q[q] && e50q[q] < e50q[q - 3];
    }
    const k = c15[j];
    const last5 = c15.slice(j - 4, j + 1);
    let side = 0, sl;
    if (up && k.l <= e20[j] && k.c > e20[j] && k.c > k.o) {
      side = 1;
      sl = Math.min(...last5.map((x) => x.l)) - 0.25 * a15[j];
    } else if (down && k.h >= e20[j] && k.c < e20[j] && k.c < k.o) {
      side = -1;
      sl = Math.max(...last5.map((x) => x.h)) + 0.25 * a15[j];
    }
    if (!side) continue;
    const dist = Math.abs(k.c - sl);
    if (dist < 0.5 * a15[j] || dist > 3 * a15[j]) continue;
    orders.push({
      a, side, type: 'market', sl,
      tpR: v.exit === 'trail' ? null : v.exit,
      trail: v.exit === 'trail' ? 3 * a15[j] : null,
      exitIdx: a + (v.exit === 'trail' ? 864 : 576),
    });
  }
  return orders;
}

// B — Breakout phiên: vùng giá phiên Á 00:00–07:00 UTC; nến 15m đầu tiên đóng ngoài vùng
//   trong 07:00–16:00 UTC -> Market. Mỗi ngày tối đa 1 lệnh (chỉ breakout đầu tiên).
//   Bỏ ngày có vùng < 0.2 hoặc > 1.0 ATR ngày. SL: 'mid' giữa vùng | 'opp' cạnh đối diện.
//   TP: 1.5R | 2R. Đóng hết lúc 21:00 UTC. Lọc xu hướng tuỳ chọn: chỉ theo chiều giá vs EMA50 4h.
export function stratB(ctx, v) {
  const { m5, idx, c15, c4h, c1d } = ctx;
  const a1d = atr(c1d, 14), e50q = ema(c4h.map((k) => k.c), 50);
  const atD = lastClosed(c1d), at4h = lastClosed(c4h);
  const orders = [];
  const firstDay = Math.ceil(m5[0].t / DAY) * DAY;
  let j = 0;
  for (let d = firstDay; d < m5.at(-1).t; d += DAY) {
    const ia = idx.get(d), ib = idx.get(d + 7 * HOUR);
    if (ia == null || ib == null) continue;
    let H = -Infinity, Lo = Infinity;
    for (let i = ia; i < ib; i++) {
      H = Math.max(H, m5[i].h);
      Lo = Math.min(Lo, m5[i].l);
    }
    const di = atD(d);
    if (di < 15) continue;
    const w = H - Lo;
    if (w < 0.2 * a1d[di] || w > 1.0 * a1d[di]) continue;
    while (j < c15.length && c15[j].t < d + 7 * HOUR) j++;
    for (let jj = j; jj < c15.length && c15[jj].ct + 1 <= d + 16 * HOUR; jj++) {
      const k = c15[jj];
      const side = k.c > H ? 1 : k.c < Lo ? -1 : 0;
      if (!side) continue;
      const T = k.ct + 1;
      if (v.trend) {
        const q = at4h(T);
        if (q < 50 || Math.sign(c4h[q].c - e50q[q]) !== side) break;
      }
      const a = idx.get(T), end = idx.get(d + 21 * HOUR - 5 * MIN);
      if (a == null || end == null) break;
      const sl = v.sl === 'mid' ? (H + Lo) / 2 : side > 0 ? Lo : H;
      orders.push({ a, side, type: 'market', sl, tpR: v.tpR, exitIdx: end });
      break;
    }
  }
  return orders;
}

// C — Hồi về trung bình trong vùng sideway, vào bằng lệnh Limit (phí maker).
//   Sideway: ADX(14) 1h < 20 (bản 'noRegime' bỏ lọc này để đối chứng).
//   Khi nến 15m đóng ở nửa dưới dải Bollinger(20,k): đặt Buy Limit ở dải dưới, hiệu lực 15 phút.
//   SL: entry - m*ATR(15m) (stop, taker). TP: đường giữa (limit, maker). Tối đa 6 giờ.
export function stratC(ctx, v) {
  const { idx, c15, c1h } = ctx;
  const cl = c15.map((k) => k.c);
  const mid = sma(cl, 20), sd = stdev(cl, 20), a15 = atr(c15, 14), ax = adx(c1h, 14);
  const at1h = lastClosed(c1h);
  const orders = [];
  for (let j = 30; j < c15.length; j++) {
    const T = c15[j].ct + 1;
    const a = idx.get(T);
    if (a == null) continue;
    if (v.regime) {
      const h = at1h(T);
      if (h < 50 || !(ax[h] < 20)) continue;
    }
    const lo = mid[j] - v.k * sd[j], up = mid[j] + v.k * sd[j], c = cl[j];
    if (mid[j] - lo < 0.5 * a15[j]) continue; // band too tight to pay the fees
    if (c < mid[j] && c > lo) {
      orders.push({ a, side: 1, type: 'limit', price: lo, exp: 3, sl: lo - v.m * a15[j], tp: mid[j], exitIdx: a + 72 });
    } else if (c > mid[j] && c < up) {
      orders.push({ a, side: -1, type: 'limit', price: up, exp: 3, sl: up + v.m * a15[j], tp: mid[j], exitIdx: a + 72 });
    }
  }
  return orders;
}

export const VARIANTS = {
  A: [
    { name: 'A trend1h TP2R', trend: '1h', exit: 2 },
    { name: 'A trend1h TP3R', trend: '1h', exit: 3 },
    { name: 'A trend1h trail', trend: '1h', exit: 'trail' },
    { name: 'A trend4h TP2R', trend: '4h', exit: 2 },
    { name: 'A trend4h TP3R', trend: '4h', exit: 3 },
    { name: 'A trend4h trail', trend: '4h', exit: 'trail' },
  ],
  B: [
    { name: 'B slMid TP1.5R', sl: 'mid', tpR: 1.5, trend: false },
    { name: 'B slMid TP2R', sl: 'mid', tpR: 2, trend: false },
    { name: 'B slOpp TP1.5R', sl: 'opp', tpR: 1.5, trend: false },
    { name: 'B slOpp TP2R', sl: 'opp', tpR: 2, trend: false },
    { name: 'B slMid TP1.5R +4h', sl: 'mid', tpR: 1.5, trend: true },
    { name: 'B slMid TP2R +4h', sl: 'mid', tpR: 2, trend: true },
    { name: 'B slOpp TP1.5R +4h', sl: 'opp', tpR: 1.5, trend: true },
    { name: 'B slOpp TP2R +4h', sl: 'opp', tpR: 2, trend: true },
  ],
  C: [
    { name: 'C bb2.0 sl1.0', k: 2, m: 1, regime: true },
    { name: 'C bb2.0 sl1.5', k: 2, m: 1.5, regime: true },
    { name: 'C bb2.5 sl1.0', k: 2.5, m: 1, regime: true },
    { name: 'C bb2.5 sl1.5', k: 2.5, m: 1.5, regime: true },
    { name: 'C bb2.0 sl1.0 noRegime', k: 2, m: 1, regime: false },
  ],
};
export const FN = { A: stratA, B: stratB, C: stratC };
