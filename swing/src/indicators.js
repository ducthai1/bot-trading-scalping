// Indicators identical to the research backtests (Wilder smoothing seeded with a simple average).

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function rma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let x;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) x = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else if (i >= period) x = (x * (period - 1) + values[i]) / period;
    out[i] = x;
  }
  return out;
}

export function rsi(closes, period) {
  const gain = [0], loss = [0];
  for (let i = 1; i < closes.length; i++) {
    gain.push(Math.max(closes[i] - closes[i - 1], 0));
    loss.push(Math.max(closes[i - 1] - closes[i], 0));
  }
  const ag = rma(gain, period), al = rma(loss, period);
  return closes.map((_, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i])));
}

export function atr(candles, period) {
  const tr = candles.map((k, i) => (i ? Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c)) : k.h - k.l));
  return rma(tr, period);
}
