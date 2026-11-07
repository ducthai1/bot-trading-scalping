// "If today's candle closed at the current price" watchlist — uses the live daily candle from the
// WebSocket on top of the cached closed candles. Informational only: signals are acted on at the close.
import { buildSeries, r3Entry, breakoutEntry, breakoutLevel, trendUp } from './strategy.js';
import { DAY, dayStart } from './util.js';

export function watchlist({ cfg, cache, liveDaily, prices, now }) {
  const today = dayStart(now);
  const rows = [];
  let btcTrend = null;
  for (const symbol of cfg.coins) {
    const closed = cache.get(symbol);
    if (!closed?.length) continue;
    const live = liveDaily[symbol]?.t === today && closed.at(-1).t === today - DAY ? liveDaily[symbol] : null;
    const candles = live ? [...closed, live] : closed;
    const S = buildSeries(candles);
    const i = candles.length - 1;
    let streak = 0;
    while (streak < 6 && i - streak > 0 && S.r2[i - streak] < S.r2[i - streak - 1]) streak++;
    const level = breakoutLevel(S, i, cfg.breakout.lookback);
    const row = {
      symbol,
      provisional: !!live,
      price: prices[symbol] ?? S.c[i],
      chgToday: live ? live.c / live.o - 1 : null,
      trend: trendUp(S, i),
      rsi2: S.r2[i],
      rsiFalling: streak,
      r3: r3Entry(S, i, cfg.r3),
      level,
      toLevel: level / S.c[i] - 1,
      breakout: breakoutEntry(S, i, cfg.breakout),
      atrPct: S.atr[i] / S.c[i],
    };
    if (symbol === 'BTCUSDT') btcTrend = row.trend;
    rows.push(row);
  }
  // Signals first, then the closest to triggering (deep RSI fall / price near the 20-day high).
  const score = (r) => (r.r3 || r.breakout ? -10 : 0) + Math.min(r.trend ? r.rsi2 / 100 : 1, Math.max(r.toLevel, 0) * 10);
  rows.sort((a, b) => score(a) - score(b));
  return { at: now, btcTrend, rows };
}
