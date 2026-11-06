// EMA seeded by SMA of the first `period` values; NaN before that.
export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Simple-average ATR over `period` true ranges.
export function atr(candles, period = 14) {
  const tr = candles.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const pc = candles[i - 1].c;
    return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += tr[j];
    out[i] = s / period;
  }
  return out;
}

// Mean of values[i-period .. i-1] (excludes bar i itself).
export function avgPrev(values, period, i) {
  if (i < period) return NaN;
  let s = 0;
  for (let j = i - period; j < i; j++) s += values[j];
  return s / period;
}
