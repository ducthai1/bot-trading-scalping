// EMA Ribbon Pullback Scalping (Andrew Lockwood) — 5 iron-clad rules as pure code.
// Short setups are evaluated by mirroring prices (p -> -p) and running the Long logic,
// so both sides share exactly the same rules.
import { ema, atr, avgPrev } from './indicators.js';

const no = (reason) => ({ noSignal: true, reason });
const round1 = (v) => Math.round(v * 10) / 10;
const mirror = (cs) => cs.map((k) => ({ ...k, o: -k.o, h: -k.l, l: -k.h, c: -k.c }));

function ribbon(cs) {
  const c = cs.map((k) => k.c);
  return { e8: ema(c, 8), e13: ema(c, 13), e21: ema(c, 21) };
}

function order(r, i) {
  if (r.e8[i] > r.e13[i] && r.e13[i] > r.e21[i]) return 'up';
  if (r.e8[i] < r.e13[i] && r.e13[i] < r.e21[i]) return 'down';
  return 'mixed';
}

// "Máy xay thịt": EMA8 and EMA21 cross each other repeatedly (đan xoắn) inside the lookback,
// or (chopPriceFlips > 0) the close keeps flipping sides of EMA21 (giá đâm xuyên dải hai chiều).
// A normal pullback only makes EMA8 dip toward EMA13 — that is not a cross and must not count.
function isChop(cs, r, n, cfg) {
  let crosses = 0;
  let flips = 0;
  for (let i = n - cfg.chopLookback + 1; i <= n; i++) {
    if (Math.sign(r.e8[i] - r.e21[i]) !== Math.sign(r.e8[i - 1] - r.e21[i - 1])) crosses++;
    if (Math.sign(cs[i].c - r.e21[i]) !== Math.sign(cs[i - 1].c - r.e21[i - 1])) flips++;
  }
  return crosses >= cfg.chopFlips || (cfg.chopPriceFlips > 0 && flips >= cfg.chopPriceFlips);
}

const enoughData = (cs, cfg) => cs.length > 21 + cfg.chopLookback + 1;

// Big-picture trend (1H / 15m): 'up' | 'down' | 'chop' | 'none'.
export function trendOf(cs, cfg) {
  if (!enoughData(cs, cfg)) return 'none';
  const r = ribbon(cs);
  const n = cs.length - 1;
  const b = cfg.slopeBars;
  if (isChop(cs, r, n, cfg)) return 'chop';
  // "Xòe rộng" / "dốc": measured in ATR of this timeframe when set, so 1H and 15m are judged alike.
  const a = atr(cs, 14)[n];
  const gap = Math.abs(r.e8[n] - r.e21[n]);
  if (cfg.spreadMinAtr ? gap < cfg.spreadMinAtr * a : gap / Math.abs(cs[n].c) < cfg.spreadMinPct) return 'chop';
  const minSlope = (cfg.slopeMinAtr || 0) * a;
  const lines = ['e8', 'e13', 'e21'];
  if (order(r, n) === 'up' && lines.every((e) => r[e][n] - r[e][n - b] > minSlope) && cs[n].c > r.e21[n]) return 'up';
  if (order(r, n) === 'down' && lines.every((e) => r[e][n - b] - r[e][n] > minSlope) && cs[n].c < r.e21[n]) return 'down';
  return 'none';
}

// Long setup on the trigger timeframe; last candle = closed confirmation candle.
function longSetup(cs, cfg) {
  if (!enoughData(cs, cfg)) return no('Thiếu dữ liệu nến');
  const n = cs.length - 1;
  const r = ribbon(cs);
  const a = atr(cs, 14);
  const vol = cs.map((k) => k.v);

  if (isChop(cs, r, n, cfg)) return no('Khung bóp cò sideway (EMA đan xoắn)');

  // Bước 2: count pullback candles since the latest swing extreme.
  let s = n - 1;
  for (let i = n - 1; i >= n - cfg.swingLookback; i--) if (cs[i].h > cs[s].h) s = i;
  const pb = n - 1 - s;
  if (pb < cfg.pullbackMin) return no(`Pullback ${pb} nến < ${cfg.pullbackMin} (chống FOMO)`);
  if (pb > cfg.pullbackMax) return no(`Pullback ${pb} nến > ${cfg.pullbackMax}`);
  if (!(cs[s].c > r.e8[s])) return no('Trước nhịp hồi giá không nằm ngoài dải EMA');

  // Bước 3: liquidity shock — a pullback candle (against the trend) whose body pierces the whole
  // ribbon on huge volume. The confirmation candle is not part of the pullback.
  for (let i = s + 1; i < n; i++) {
    const k = cs[i];
    if (!(k.c < k.o)) continue;
    const lo = Math.min(r.e8[i], r.e13[i], r.e21[i]);
    const hi = Math.max(r.e8[i], r.e13[i], r.e21[i]);
    if (Math.min(k.o, k.c) < lo && Math.max(k.o, k.c) > hi && k.v > cfg.shockVolMult * avgPrev(vol, 20, i)) {
      return no('Sốc thanh khoản: nến xuyên thủng cả dải EMA với volume lớn');
    }
  }

  // Bước 1 (trigger TF): ribbon order + EMA21 slope agree with the big picture.
  if (order(r, n) !== 'up' || !(r.e21[n] > r.e21[n - cfg.slopeBars])) {
    return no('Khung bóp cò không đồng pha với đại cục');
  }

  // Bước 2: pullback must be slow — small candles only.
  for (let i = s + 1; i <= n - 1; i++) {
    if (Math.abs(cs[i].c - cs[i].o) >= cfg.smallBodyAtr * a[i]) return no('Nhịp hồi có nến lớn (không từ tốn)');
  }
  // ...and must actually drift down to the ribbon, not stall at the top and stab into it with one candle.
  if (cfg.pullbackReachEma8) {
    let reached = false;
    for (let i = s + 1; i < n; i++) if (cs[i].l <= r.e8[i]) reached = true;
    if (!reached) return no('Nhịp hồi chưa tiến về dải EMA (nến xác nhận cắm thẳng vào Killzone)');
  }

  // Bước 4: Killzone between EMA8 and EMA21 (must reach EMA13, must not close beyond EMA21).
  const k = cs[n];
  if (!(k.l <= r.e13[n] && k.c > r.e21[n])) return no('Chưa vào Killzone EMA13–EMA21');
  const touchedEma = k.l <= r.e21[n] ? 21 : 13;

  // Bước 5: rejection candle (already closed).
  const range = k.h - k.l;
  const green = k.c > k.o;
  const solidBody = green && (k.c - k.o) / range >= cfg.bodyMinRatio;
  const longWick = (Math.min(k.o, k.c) - k.l) / range >= cfg.wickMinRatio;
  if (!(range > 0 && (solidBody || longWick))) return no('Nến xác nhận chưa từ chối giá');

  // Risk: SL from the wick, distance must be within [slMin, slMax]. Too long -> cancel (spec).
  // Too short -> widen to slMin (still beyond the wick) when slWidenToMin, else cancel.
  const entry = k.c;
  let sl = k.l - cfg.slBuffer;
  let dist = entry - sl;
  if (dist > cfg.slMax || (dist < cfg.slMin && !cfg.slWidenToMin)) {
    return no(`SL ${dist.toFixed(1)} giá ngoài [${cfg.slMin}, ${cfg.slMax}]`);
  }
  if (dist < cfg.slMin) {
    sl = entry - cfg.slMin;
    dist = cfg.slMin;
  }
  const tp1 = cs[s].h;
  if (!(tp1 > entry)) return no('TP1 (đỉnh cục bộ) không nằm trên Entry');
  // Fees in price points: Market entry (taker) + exit at SL (taker) or TP1 (limit, maker).
  if (cfg.minNetRR != null) {
    const px = Math.abs(entry);
    const netRisk = dist + px * 2 * cfg.takerFee;
    const netReward = tp1 - entry - px * (cfg.takerFee + cfg.makerFee);
    if (netReward < cfg.minNetRR * netRisk) return no(`R:R sau phí ${(netReward / netRisk).toFixed(2)} < ${cfg.minNetRR}`);
  }
  const tp2 = (Math.floor(tp1 / cfg.roundStep) + 1) * cfg.roundStep;

  return { entry, sl, tp1, tp2, pb, touchedEma, green, s };
}

/**
 * @param {{h1:Array, m15:Array, candles:Array, tf:string, cfg:object}} p  closed candles only
 * @returns {{signal:object}|{noSignal:true, reason:string}}
 */
export function evaluate({ h1, m15, candles, tf, cfg }) {
  const t1 = trendOf(h1, cfg);
  const t15 = trendOf(m15, cfg);
  if (t1 === 'chop' || t15 === 'chop') return no(`Đại cục sideway (1H=${t1}, 15m=${t15})`);
  if (t1 === 'none' || t1 !== t15) return no(`Đại cục không đồng pha (1H=${t1}, 15m=${t15})`);

  const short = t1 === 'down';
  const res = longSetup(short ? mirror(candles) : candles, cfg);
  if (res.noSignal) return res;

  const px = (v) => round1(short ? -v : v);
  const side = short ? 'SHORT' : 'LONG';
  return {
    signal: {
      side,
      tf,
      htfTrend: short ? 'Downtrend' : 'Uptrend',
      touchedEma: res.touchedEma,
      pbCount: res.pb,
      color: (short ? !res.green : res.green) ? 'Xanh' : 'Đỏ',
      entry: px(res.entry),
      sl: px(res.sl),
      tp1: px(res.tp1),
      tp2: px(res.tp2),
      time: candles[candles.length - 1].ct,
      key: `${tf}:${side}:${candles[res.s].t}`,
    },
  };
}
