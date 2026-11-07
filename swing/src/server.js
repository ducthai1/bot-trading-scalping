// Dashboard + JSON/CSV API. Binds to 127.0.0.1 by default; actions need SWING_ADMIN_KEY.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { buildReport, toCSV } from './report.js';
import { loadHistory } from './history.js';
import { isoDay } from './util.js';

const pct = (x) => (x == null ? '' : (x * 100).toFixed(3));

export function startServer({ cfg, store, getState, status, tg, triggers, log, nextDailyAt, netStats, getWatch = () => null, getLive = () => null }) {
  const html = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
  const key = process.env.SWING_ADMIN_KEY || process.env.ADMIN_KEY || '';
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const csv = (res, name, text) => send(res, 200, '﻿' + text, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${name}"` });
  const report = () => buildReport({ cfg, state: getState(), history: loadHistory(store), status: { ...status, nextDailyAt: nextDailyAt(), net: { ...netStats } }, now: Date.now() });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && p === '/') return send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:" });
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: !status.lastError, busy: status.busy, lastDailyOk: status.lastDailyOk, lastError: status.lastError, lastClosedDay: getState().lastClosedDay });
      if (req.method === 'GET' && p === '/api/report') return send(res, 200, report());
      if (req.method === 'GET' && p === '/api/live') {
        const st = getState();
        const live = getLive();
        const prices = live?.prices ?? {};
        const open = st.positions.map((p) => {
          const px = prices[p.symbol] ?? p.lastPx;
          const value = p.qty * px * (1 - cfg.fees.taker);
          return { id: p.id, symbol: p.symbol, strategy: p.strategy, px, ret: value / p.cost - 1, pnl: value - p.cost, toSL: p.sl ? (p.sl / px - 1) * 100 : null, toTP: p.tp ? (p.tp / px - 1) * 100 : null };
        });
        const equity = st.cash + st.positions.reduce((a, p) => a + p.qty * (prices[p.symbol] ?? p.lastPx), 0);
        return send(res, 200, { now: Date.now(), feed: live?.feed ?? null, equity, open, shadowsOpen: st.shadows.length, queue: status.queue, watch: getWatch() });
      }
      if (req.method === 'GET' && p === '/api/trades.csv') {
        const { trades } = loadHistory(store);
        return csv(res, 'swing-trades.csv', toCSV(trades, [
          ['id', (t) => t.id], ['strategy', (t) => t.strategy], ['symbol', (t) => t.symbol], ['entry_time_utc', (t) => new Date(t.entryTime).toISOString()], ['entry_px', (t) => t.entryPx],
          ['qty', (t) => t.qty], ['cost_usd', (t) => t.cost.toFixed(4)], ['sl', (t) => t.sl], ['tp', (t) => t.tp], ['exit_time_utc', (t) => new Date(t.exitTime).toISOString()], ['exit_px', (t) => t.exitPx],
          ['pnl_usd', (t) => t.pnl.toFixed(4)], ['ret_pct', (t) => pct(t.ret)], ['R', (t) => t.R?.toFixed(3)], ['days', (t) => t.days], ['exit_reason', (t) => t.reason], ['mfe_pct', (t) => pct(t.mfe)], ['mae_pct', (t) => pct(t.mae)], ['late_entry', (t) => t.lateEntry], ['late_exit', (t) => t.lateExit],
        ]));
      }
      if (req.method === 'GET' && p === '/api/signals.csv') {
        const { signals } = loadHistory(store);
        return csv(res, 'swing-signals.csv', toCSV(signals, [
          ['id', (s) => s.id], ['day_utc', (s) => isoDay(s.day)], ['strategy', (s) => s.strategy], ['symbol', (s) => s.symbol], ['btc_ok', (s) => s.btcOk], ['status', (s) => s.status], ['skip_reason', (s) => s.reason],
          ['values', (s) => s.values], ['entry_px', (s) => s.entryPx], ['result_exit_utc', (s) => (s.result ? new Date(s.result.exitTime).toISOString() : '')], ['result_exit_px', (s) => s.result?.exitPx],
          ['result_ret_pct', (s) => pct(s.result?.ret)], ['result_R', (s) => s.result?.R?.toFixed(3)], ['result_days', (s) => s.result?.days], ['result_reason', (s) => s.result?.reason], ['mfe_pct', (s) => pct(s.result?.mfe)], ['mae_pct', (s) => pct(s.result?.mae)], ['correct', (s) => (s.result ? s.result.ret > 0 : '')],
        ]));
      }
      if (req.method === 'GET' && p === '/api/equity.csv') {
        const { equity } = loadHistory(store);
        return csv(res, 'swing-equity.csv', toCSV(equity, [['day_utc', (e) => isoDay(e.t)], ['equity', (e) => e.equity.toFixed(4)], ['cash', (e) => e.cash.toFixed(4)], ['drawdown_pct', (e) => pct(e.dd)], ['open_positions', (e) => e.open]]));
      }
      if (p.startsWith('/api/admin/')) {
        if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Dùng POST' });
        if (!key) return send(res, 403, { ok: false, error: 'Chưa đặt biến SWING_ADMIN_KEY nên các thao tác đang tắt.' });
        if ((req.headers['x-admin-key'] || url.searchParams.get('key')) !== key) return send(res, 403, { ok: false, error: 'Sai key' });
        if (status.busy) return send(res, 409, { ok: false, error: `Bot đang chạy job ${status.busy}, thử lại sau` });
        const action = p.slice('/api/admin/'.length);
        if (action === 'run') {
          await triggers.due();
          return send(res, 200, { ok: !status.lastError, error: status.lastError?.message ?? null });
        }
        if (action === 'reset-breaker') {
          const r = triggers.resetBreaker();
          log('warn', `Cầu dao được reset thủ công (đỉnh vốn mới = ${r.peak.toFixed(2)}$)`);
          return send(res, 200, { ok: true });
        }
        if (action === 'test-telegram') {
          const ok = await tg.send('✅ Test từ dashboard swing bot — Telegram hoạt động.');
          return send(res, ok ? 200 : 500, { ok, error: ok ? null : tg.enabled ? 'Gửi thất bại, xem log' : 'Telegram chưa cấu hình hoặc đang chạy --dry' });
        }
        return send(res, 404, { ok: false, error: 'Không có thao tác này' });
      }
      return send(res, 404, { ok: false, error: 'Not found' });
    } catch (e) {
      log('error', `Dashboard lỗi: ${e.stack || e.message}`);
      return send(res, 500, { ok: false, error: e.message });
    }
  });
  server.on('error', (e) => log('error', `Dashboard không mở được ${cfg.server.host}:${cfg.server.port} — ${e.message}`));
  server.listen(cfg.server.port, cfg.server.host, () => log('info', `🌐 Dashboard: http://${cfg.server.host}:${cfg.server.port}`));
  return server;
}
