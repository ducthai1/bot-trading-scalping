// Reads the append-only tables back into memory. Rows carry stable ids, so a day that was
// re-processed after a crash (logs written, state not yet saved) never shows up twice.
const lastBy = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];

export function persistEvents(store, events) {
  const pick = (type) => events.filter((e) => e.type === type);
  store.append('trades.jsonl', pick('trade_close').map((e) => e.trade));
  store.append('orders.jsonl', pick('trade_open').map((e) => e.position));
  store.append('signals.jsonl', events.filter((e) => e.type === 'signal' || e.type === 'signal_update' || e.type === 'signal_result' || e.type === 'signal_forward'));
  store.append('equity.jsonl', pick('equity'));
  store.append('events.jsonl', pick('breaker').map((e) => ({ at: Date.now(), level: 'warn', msg: `Cầu dao ngắt: sụt ${(e.dd * 100).toFixed(1)}%`, day: e.at })));
}

export function loadHistory(store) {
  const signals = new Map();
  for (const r of store.readJSONL('signals.jsonl')) {
    if (r.type === 'signal') signals.set(r.id, { ...r, status: signals.get(r.id)?.status ?? 'pending', reason: signals.get(r.id)?.reason ?? null, result: signals.get(r.id)?.result ?? null, forward: signals.get(r.id)?.forward ?? null });
    else if (r.type === 'signal_update') signals.set(r.id, { ...(signals.get(r.id) || { id: r.id }), status: r.status, reason: r.reason, entryPx: r.entryPx, positionId: r.positionId });
    else if (r.type === 'signal_result') signals.set(r.id, { ...(signals.get(r.id) || { id: r.id }), result: r });
    else if (r.type === 'signal_forward') {
      const s = signals.get(r.id) || { id: r.id };
      signals.set(r.id, { ...s, forward: { ...(s.forward || {}), [r.h]: { ret: r.ret, basket: r.basket } } });
    }
  }
  return {
    trades: lastBy(store.readJSONL('trades.jsonl'), (t) => t.id).sort((a, b) => a.exitTime - b.exitTime),
    orders: lastBy(store.readJSONL('orders.jsonl'), (o) => o.id),
    equity: lastBy(store.readJSONL('equity.jsonl'), (e) => e.t).sort((a, b) => a.t - b.t),
    signals: [...signals.values()].filter((s) => s.day != null).sort((a, b) => a.day - b.day || a.id.localeCompare(b.id, 'en', { numeric: true })),
    events: store.readJSONL('events.jsonl').slice(-500),
  };
}
