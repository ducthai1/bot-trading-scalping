// Analytics for the dashboard (pure): live P&L, per-period stats, signal accuracy vs backtest.
import { SKIP_REASON, EXIT_REASON, STRAT_NAME } from './labels.js';

const month = (ms) => new Date(ms).toISOString().slice(0, 7);
const year = (ms) => new Date(ms).toISOString().slice(0, 4);
const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);

// 95% Wilson interval for a proportion, in %.
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((c - m) / d) * 100, ((c + m) / d) * 100];
}

export function tradeStats(T) {
  const wins = T.filter((t) => t.ret > 0), losses = T.filter((t) => t.ret <= 0);
  const gp = wins.reduce((s, t) => s + t.ret, 0), gl = -losses.reduce((s, t) => s + t.ret, 0);
  return {
    n: T.length,
    win: T.length ? (wins.length / T.length) * 100 : null,
    winCI: wilson(wins.length, T.length),
    avgWin: wins.length ? (gp / wins.length) * 100 : null,
    avgLoss: losses.length ? (-gl / losses.length) * 100 : null,
    avgRet: avg(T, (t) => t.ret * 100),
    avgR: T.some((t) => t.R != null) ? avg(T.filter((t) => t.R != null), (t) => t.R) : null,
    tpRate: T.some((t) => t.reason === 'TP' || t.reason === 'SL') ? (T.filter((t) => t.reason === 'TP').length / T.length) * 100 : null,
    pf: gl ? gp / gl : null,
    pnl: T.reduce((s, t) => s + (t.pnl ?? 0), 0),
    hold: avg(T, (t) => t.days),
    worst: T.length ? Math.min(...T.map((t) => t.ret)) * 100 : null,
    best: T.length ? Math.max(...T.map((t) => t.ret)) * 100 : null,
  };
}

function periodTable(equity, trades, keyOf, capital) {
  const keys = [...new Set([...equity.map((e) => keyOf(e.t)), ...trades.map((t) => keyOf(t.exitTime))])].sort();
  let prevEnd = capital;
  return keys.map((k) => {
    const eq = equity.filter((e) => keyOf(e.t) === k);
    const end = eq.at(-1)?.equity ?? prevEnd;
    const T = trades.filter((t) => keyOf(t.exitTime) === k);
    const row = { period: k, start: prevEnd, end, ret: (end / prevEnd - 1) * 100, maxDD: 0, all: tradeStats(T), R3: tradeStats(T.filter((t) => t.strategy === 'R3')), BREAKOUT: tradeStats(T.filter((t) => t.strategy === 'BREAKOUT')) };
    let peak = prevEnd;
    for (const e of eq) {
      peak = Math.max(peak, e.equity);
      row.maxDD = Math.max(row.maxDD, (1 - e.equity / peak) * 100);
    }
    prevEnd = end;
    return row;
  });
}

function signalAccuracy(signals, groupOf) {
  const groups = {};
  for (const s of signals) {
    const g = groupOf(s);
    if (g == null) continue;
    (groups[g] ||= []).push(s);
  }
  return Object.entries(groups).map(([g, S]) => {
    const done = S.filter((s) => s.result);
    const right = done.filter((s) => s.result.ret > 0);
    return { group: g, signals: S.length, resolved: done.length, open: S.length - done.length, accuracy: done.length ? (right.length / done.length) * 100 : null, accuracyCI: wilson(right.length, done.length), avgRet: avg(done, (s) => s.result.ret * 100), avgR: done.some((s) => s.result.R != null) ? avg(done.filter((s) => s.result.R != null), (s) => s.result.R) : null, avgMfe: avg(done, (s) => s.result.mfe * 100), avgMae: avg(done, (s) => s.result.mae * 100), avgDays: avg(done, (s) => s.result.days) };
  });
}

// Pure forward returns after each signal vs the equal-weight basket of all coins.
export function forwardStats(signals, horizons = [1, 3, 5, 10]) {
  const rows = [];
  for (const strat of ['R3', 'BREAKOUT']) {
    for (const h of horizons) {
      const xs = signals.filter((s) => s.strategy === strat && s.forward?.[h]).map((s) => s.forward[h]);
      if (!xs.length) {
        rows.push({ strategy: strat, h, n: 0 });
        continue;
      }
      const ex = xs.map((x) => (x.ret - x.basket) * 100);
      const m = ex.reduce((a, x) => a + x, 0) / ex.length;
      const sd = Math.sqrt(ex.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, ex.length - 1));
      rows.push({ strategy: strat, h, n: xs.length, avgRet: avg(xs, (x) => x.ret * 100), avgBasket: avg(xs, (x) => x.basket * 100), avgExcess: m, excessCI: ex.length > 1 ? [m - (1.96 * sd) / Math.sqrt(ex.length), m + (1.96 * sd) / Math.sqrt(ex.length)] : null, beatPct: (ex.filter((x) => x > 0).length / ex.length) * 100 });
    }
  }
  return rows;
}

// Trial verdict: is live behaviour consistent with the backtest so far?
export function evaluation({ cfg, state, trades, signals, forward, now }) {
  const start = state.createdAt ?? signals[0]?.day ?? now;
  const weekAgo = now - 7 * 86400e3;
  const wk = signals.filter((s) => s.day >= weekAgo);
  const wkDone = wk.filter((s) => s.result);
  const wkTrades = trades.filter((t) => t.exitTime >= weekAgo);
  const strategies = ['R3', 'BREAKOUT'].map((k) => {
    const done = signals.filter((s) => s.strategy === k && s.result);
    const right = done.filter((s) => s.result.ret > 0).length;
    const ci = wilson(right, done.length);
    const expected = cfg.expectations?.[k]?.signalAccuracy ?? null;
    const f5 = forward.find((r) => r.strategy === k && r.h === 5);
    let verdict = 'Chưa đủ mẫu (cần ≥ 20 tín hiệu có kết quả)';
    if (done.length >= 20 && ci && expected != null) verdict = expected < ci[0] ? 'Tốt hơn backtest' : expected > ci[1] ? '⚠️ Kém hơn backtest rõ rệt' : 'Phù hợp backtest';
    return { key: k, name: STRAT_NAME[k], resolved: done.length, open: signals.filter((s) => s.strategy === k && !s.result).length, accuracy: done.length ? (right / done.length) * 100 : null, ci, expected, verdict, fwd5: f5?.n ? f5.avgExcess : null, fwd5n: f5?.n ?? 0, fwd5CI: f5?.excessCI ?? null, fwd5Exp: cfg.expectations?.[k]?.forwardExcess?.['5'] ?? null };
  });
  const bad = strategies.filter((s) => s.verdict.startsWith('⚠️'));
  const enough = strategies.filter((s) => s.resolved >= 20);
  const overall = bad.length
    ? `${bad.map((s) => s.name).join(', ')} đang kém hơn backtest rõ rệt — nên tạm dừng và xem lại trước khi dùng tiền thật.`
    : !enough.length
      ? `Mới ${strategies.map((s) => `${s.name} ${s.resolved}`).join(' · ')} tín hiệu có kết quả — chưa đủ để kết luận (cần ≥ 20 mỗi chiến lược, thường 3–6 tuần).`
      : `${enough.map((s) => s.name).join(', ')} đang phù hợp hoặc tốt hơn backtest. Tiếp tục theo dõi đủ 1 tháng trước khi dùng tiền thật.`;
  return { startedAt: start, daysRunning: Math.max(1, Math.round((now - start) / 86400e3)), week: { signals: wk.length, resolved: wkDone.length, accuracy: wkDone.length ? (wkDone.filter((s) => s.result.ret > 0).length / wkDone.length) * 100 : null, trades: wkTrades.length, pnl: wkTrades.reduce((a, t) => a + t.pnl, 0) }, strategies, overall };
}

export function buildReport({ cfg, state, history, status, now }) {
  const { trades, equity, signals, events, orders } = history;
  const prices = status.prices || {};
  const open = state.positions.map((p) => {
    const px = prices[p.symbol] ?? p.lastPx ?? p.entryPx;
    const value = p.qty * px * (1 - cfg.fees.taker);
    const sig = signals.find((s) => s.id === p.signalId);
    return { ...p, px, value, pnl: value - p.cost, ret: value / p.cost - 1, R: p.risk ? ((px - p.entryPx) / p.risk) : null, daysHeld: Math.max(0, Math.floor((now - p.entryTime) / 86400e3)), toSL: p.sl ? (p.sl / px - 1) * 100 : null, toTP: p.tp ? (p.tp / px - 1) * 100 : null, signal: sig?.values ?? null };
  });
  const liveEquity = state.cash + open.reduce((s, p) => s + p.qty * p.px, 0);
  const closedPnl = trades.reduce((s, t) => s + t.pnl, 0);
  let peak = state.capital, maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.equity);
    maxDD = Math.max(maxDD, 1 - e.equity / peak);
  }
  const byStrategy = Object.fromEntries(['R3', 'BREAKOUT'].map((s) => [s, tradeStats(trades.filter((t) => t.strategy === s))]));
  const skipCounts = {};
  for (const s of signals) if (s.status === 'skipped') skipCounts[s.reason] = (skipCounts[s.reason] || 0) + 1;
  const forward = forwardStats(signals, cfg.forwardHorizons);

  return {
    now,
    config: { capital: cfg.capital, coins: cfg.coins.length, btcFilter: cfg.btcFilter, r3: cfg.r3, breakout: cfg.breakout, slotsTotal: cfg.slotsTotal, perTrade: liveEquity / cfg.slotsTotal, breakerAt: cfg.circuitBreakerDrawdown * 100, fees: cfg.fees },
    status: { ...status, prices: undefined, watch: undefined, nextDailyAt: status.nextDailyAt },
    summary: {
      capital: state.capital, equityClose: state.equity, equityLive: liveEquity, cash: state.cash, invested: open.reduce((s, p) => s + p.cost, 0),
      totalRet: (liveEquity / state.capital - 1) * 100, closedPnl, openPnl: open.reduce((s, p) => s + p.pnl, 0),
      ddNow: (1 - liveEquity / Math.max(state.peak, liveEquity)) * 100, maxDD: Math.max(maxDD, state.maxDrawdown) * 100, breaker: state.breaker,
      lastClosedDay: state.lastClosedDay, lastJob: state.lastJob ?? null, trades: trades.length, openCount: open.length, signals: signals.length,
    },
    expectations: cfg.expectations,
    forward,
    evaluation: evaluation({ cfg, state, trades, signals, forward, now }),
    byStrategy,
    open,
    trades: trades.slice().reverse().map((t) => ({ ...t, reasonText: EXIT_REASON[t.reason] ?? t.reason, strategyName: STRAT_NAME[t.strategy] })),
    monthly: periodTable(equity, trades, month, state.capital),
    yearly: periodTable(equity, trades, year, state.capital),
    accuracy: {
      byStrategy: signalAccuracy(signals, (s) => STRAT_NAME[s.strategy]),
      byDecision: signalAccuracy(signals, (s) => `${STRAT_NAME[s.strategy]} · ${s.status === 'taken' ? 'đã vào lệnh' : s.status === 'skipped' ? `bỏ qua: ${SKIP_REASON[s.reason] ?? s.reason}` : 'chờ'}`),
      byMonth: signalAccuracy(signals, (s) => `${month(s.day)} · ${STRAT_NAME[s.strategy]}`).sort((a, b) => a.group.localeCompare(b.group)),
      skipCounts,
    },
    signals: signals.slice(-500).reverse().map((s) => ({ ...s, reasonText: s.reason ? SKIP_REASON[s.reason] ?? s.reason : null, resultText: s.result ? EXIT_REASON[s.result.reason] ?? s.result.reason : null })),
    equity: equity.map((e) => ({ t: e.t, equity: e.equity, dd: e.dd })),
    orders: orders.slice(-200).reverse(),
    events: events.slice(-200).reverse(),
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCSV(rows, cols) {
  return [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','))].join('\n') + '\n';
}
