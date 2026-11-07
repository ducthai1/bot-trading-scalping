export const MIN = 60e3;
export const HOUR = 3600e3;
export const DAY = 86400e3;

export const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const fmtVN = (ms) => (ms == null ? '-' : new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }));

// Number of decimals of a Binance step string/number ("0.00100000" -> 3).
export function stepDecimals(step) {
  const s = typeof step === 'string' ? step : Number(step).toFixed(12);
  const frac = s.split('.')[1] || '';
  return frac.replace(/0+$/, '').length;
}

// Round a quantity DOWN to the exchange step (never buy more than the allocation).
export function floorStep(x, step) {
  if (!step) return x;
  const d = stepDecimals(step);
  const n = Math.floor(x / step + 1e-10); // absorbs float noise like 0.3 / 0.1 = 2.9999999999999996
  return +(n * step).toFixed(d);
}

export function roundStep(x, step) {
  if (!step) return x;
  const d = stepDecimals(step);
  return +(Math.round(x / step) * step).toFixed(d);
}

export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
