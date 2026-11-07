// Signal rules on CLOSED daily candles.
//   R3 (Connors & Alvarez, High Probability ETF Trading): close > SMA200, RSI(2) fell 3 days in a row,
//      started below 60, today < 10  -> buy next open; exit next open after RSI(2) > 70.
//   Breakout (Turtle 20-day): close > highest high of the previous 20 days -> buy next open,
//      SL = entry - 2 ATR(14), TP = entry + 3 x SL distance, max 60 days.
import { sma, rsi, atr } from './indicators.js';

export function buildSeries(candles) {
  const c = candles.map((k) => k.c);
  return {
    t: candles.map((k) => k.t),
    o: candles.map((k) => k.o),
    h: candles.map((k) => k.h),
    l: candles.map((k) => k.l),
    c,
    s200: sma(c, 200),
    r2: rsi(c, 2),
    atr: atr(candles, 14),
    idx: new Map(candles.map((k, i) => [k.t, i])),
  };
}

// minBars: a coin must have this much history before it can signal (research used 210 / 30;
// it also keeps fresh listings — which often pump right after listing — out of the backtest).
export function r3Entry(S, i, p) {
  if (i < Math.max(3, p.minBars ?? 0)) return false;
  const r = S.r2;
  return S.c[i] > S.s200[i] && r[i] < r[i - 1] && r[i - 1] < r[i - 2] && r[i - 2] < r[i - 3] && r[i - 3] < p.rsiStart && r[i] < p.rsiEntry;
}

export const r3Exit = (S, i, p) => S.r2[i] > p.rsiExit;

export function breakoutLevel(S, i, lookback) {
  let hh = -Infinity;
  for (let j = i - lookback; j < i; j++) hh = Math.max(hh, S.h[j]);
  return hh;
}

export function breakoutEntry(S, i, p) {
  if (i < Math.max(p.lookback, p.minBars ?? 0)) return false;
  return S.c[i] > breakoutLevel(S, i, p.lookback) && S.atr[i] > 0;
}

export const trendUp = (S, i) => S.c[i] > S.s200[i];
