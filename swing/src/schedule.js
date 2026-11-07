// Wall-clock scheduling (robust to laptop sleep and timer drift: checked every 30 s, never a long setTimeout).
import { DAY, MIN, dayStart } from './util.js';

// The daily job is due once the new UTC day has started (+ a few minutes so Binance has closed the
// candle) and the engine has not yet closed yesterday / opened today. Missed days are caught up.
export function dailyDue(now, state, cfg) {
  const today = dayStart(now);
  if (now < today + cfg.schedule.dailyAfterMinutes * MIN) return false; // let Binance finalize the daily candle
  return state.lastClosedDay < today - DAY || state.lastOpenedDay < today;
}

export function nextDailyAt(now, cfg) {
  const today = dayStart(now) + cfg.schedule.dailyAfterMinutes * MIN;
  return now < today ? today : today + DAY;
}

export function intradayDue(now, lastRun, cfg) {
  return now - (lastRun || 0) >= cfg.schedule.intradayEveryMinutes * MIN;
}
