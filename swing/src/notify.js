// Telegram message composition (pure). The bot never places orders — every action is for the user.
import { escapeHtml as esc, fmtVN, isoDay, stepDecimals } from './util.js';
import { SKIP_REASON, EXIT_REASON, STRAT_NAME } from './labels.js';

const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const usd = (x) => `${x >= 0 ? '' : '-'}${Math.abs(x).toFixed(2)}$`;
export function fmtPx(px, tick) {
  if (px == null) return '-';
  const d = tick ? stepDecimals(tick) : px >= 100 ? 2 : px >= 1 ? 4 : 6;
  return px.toFixed(Math.min(d, 8));
}

function buyLine(p, f) {
  const coin = p.symbol.replace(/USDT$/, '');
  let s = `• <b>${esc(p.symbol)}</b> [${STRAT_NAME[p.strategy]}] ~${p.cost.toFixed(2)}$ (${p.qty} ${coin}) giá ~${fmtPx(p.entryPx, f?.tick)}${p.late ? ' ⚠️ trễ' : ''}`;
  if (p.strategy === 'BREAKOUT') {
    s += `\n   🛑 SL ${fmtPx(p.sl, f?.tick)} (${pct(p.sl / p.entryPx - 1)}) · 🎯 TP ${fmtPx(p.tp, f?.tick)} (${pct(p.tp / p.entryPx - 1)}) → đặt lệnh OCO`;
  } else s += '\n   (không đặt SL — bán khi bot báo RSI(2) > 70)';
  return s;
}

function sellLine(t, f) {
  const coin = t.symbol.replace(/USDT$/, '');
  const oco = t.strategy === 'BREAKOUT' && t.reason === 'TIME' ? ' — HUỶ lệnh OCO trước khi bán' : '';
  return `• <b>${esc(t.symbol)}</b> [${STRAT_NAME[t.strategy]}] ${t.qty} ${coin} · ${EXIT_REASON[t.reason] ?? t.reason} — giá ~${fmtPx(t.exitPx, f?.tick)} → ${pct(t.ret)} (${usd(t.pnl)})${t.lateExit ? ' ⚠️ trễ' : ''}${oco}`;
}

export function dailyMessage({ events, state, cfg, today, now, filters, btcOk, catchUpDays, dry }) {
  const opens = events.filter((e) => e.type === 'trade_open').map((e) => e.position);
  const closes = events.filter((e) => e.type === 'trade_close').map((e) => e.trade);
  const sells = closes.filter((t) => t.reason === 'RSI2>70' || t.reason === 'TIME');
  const hits = closes.filter((t) => t.reason === 'TP' || t.reason === 'SL');
  const skipped = events.filter((e) => e.type === 'signal_update' && e.status === 'skipped');
  const signals = events.filter((e) => e.type === 'signal');
  const ddNow = 1 - state.equity / state.peak;
  const L = [];
  L.push(`📅 <b>Swing R3 + Breakout</b> — ${isoDay(today)} (${fmtVN(now)})${dry ? ' [DRY]' : ''}`);
  if (catchUpDays > 0) L.push(`⚠️ Bot đã không chạy ${catchUpDays} ngày — đã chạy bù. Lệnh MUA của những ngày đó bị bỏ (tín hiệu đã cũ); lệnh BÁN bên dưới cần làm NGAY nếu bạn đang giữ.`);
  L.push(`Vốn (sổ giả lập): <b>${state.equity.toFixed(2)}$</b> (${pct(state.equity / state.capital - 1)}) · sụt ${(ddNow * 100).toFixed(1)}% · BTC > SMA200: ${btcOk ? '✅' : '❌ (không mở lệnh mới)'}`);
  if (state.breaker) L.push(`⛔ <b>CẦU DAO ĐANG NGẮT</b> (sụt ${(state.breaker.dd * 100).toFixed(1)}%): không mở lệnh mới. Xem lại chiến lược rồi reset trên dashboard.`);
  if (sells.length) L.push('', '🔴 <b>BÁN</b> (lệnh Market trên spot):', ...sells.map((t) => sellLine(t, filters[t.symbol])));
  if (opens.length) L.push('', '🟢 <b>MUA</b> (lệnh Market trên spot):', ...opens.map((p) => buyLine(p, filters[p.symbol])));
  if (hits.length) L.push('', '📌 Lệnh Breakout đã đóng (OCO của bạn đã khớp):', ...hits.map((t) => sellLine(t, filters[t.symbol])));
  if (!sells.length && !opens.length && !hits.length) L.push('', 'Hôm nay không có lệnh nào cần làm.');
  if (skipped.length) {
    const by = {};
    for (const s of skipped) by[s.reason] = (by[s.reason] || 0) + 1;
    L.push('', `⏭ Tín hiệu không vào lệnh: ${skipped.length} (${Object.entries(by).map(([k, v]) => `${SKIP_REASON[k] ?? k}: ${v}`).join('; ')})`);
  }
  const byStrat = (s) => state.positions.filter((p) => p.strategy === s).length;
  L.push(`📂 Đang giữ: R3 ${byStrat('R3')}/${cfg.r3.maxPositions} · Breakout ${byStrat('BREAKOUT')}/${cfg.breakout.maxPositions} · tín hiệu mới hôm qua: ${signals.length}`);
  L.push('<i>Bot không tự đặt lệnh — bạn thao tác trên Binance spot. Không dùng đòn bẩy.</i>');
  return L.join('\n');
}

export function intradayMessage({ closes, filters }) {
  return ['⚡ <b>Breakout chạm SL/TP</b> (OCO của bạn đáng lẽ đã khớp — kiểm tra trên Binance):', ...closes.map((t) => sellLine(t, filters[t.symbol]))].join('\n');
}

// Human-readable lines for the event log: every signal, decision and verification result.
export function signalLogLines(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'signal') {
      const v = e.values || {};
      const what = e.strategy === 'R3' ? `RSI(2) ${v.rsi2?.toFixed(1)} (giảm 3 ngày từ ${v.rsi2Start?.toFixed(0)}), giá ${v.close} > SMA200 ${v.sma200?.toFixed(4)}` : `đóng cửa ${v.close} vượt đỉnh 20 ngày ${v.level}, ATR ${(v.atrPct * 100).toFixed(1)}%`;
      out.push(`📍 Tín hiệu ${STRAT_NAME[e.strategy]} ${e.symbol} ngày ${isoDay(e.day)} [${e.id}]: ${what}${e.btcOk ? '' : ' — BTC dưới SMA200'}`);
    } else if (e.type === 'signal_update') {
      out.push(`   ↳ ${e.id} ${e.symbol}: ${e.status === 'taken' ? `VÀO LỆNH giá ${fmtPx(e.entryPx)}` : `bỏ qua — ${SKIP_REASON[e.reason] ?? e.reason} (vẫn theo dõi giả định)`}`);
    } else if (e.type === 'signal_result') {
      out.push(`🧪 Kiểm chứng ${e.id} ${STRAT_NAME[e.strategy] ?? ''} ${e.symbol ?? ''}: ${EXIT_REASON[e.reason] ?? e.reason} → ${pct(e.ret)} sau ${e.days} ngày${e.R != null ? ` (${e.R.toFixed(2)}R)` : ''} — ${e.ret > 0 ? 'ĐÚNG' : 'SAI'} · MFE ${pct(e.mfe)} / MAE ${pct(e.mae)}`);
    } else if (e.type === 'signal_forward') {
      out.push(`📈 ${e.id} sau ${e.h} ngày: coin ${pct(e.ret)} so với rổ ${pct(e.basket)} → ${pct(e.ret - e.basket)}`);
    }
  }
  return out;
}

const f1 = (x) => (x == null ? '-' : x.toFixed(1));
export function weeklyMessage(rep) {
  const E = rep.evaluation;
  const L = [`🗓 <b>Báo cáo tuần — Swing R3 + Breakout</b> (thử nghiệm ngày thứ ${E.daysRunning})`];
  L.push(`Vốn sổ giả lập: ${rep.summary.equityLive.toFixed(2)}$ (${pct(rep.summary.totalRet / 100)}) · sụt tối đa ${f1(rep.summary.maxDD)}%`);
  L.push(`7 ngày qua: ${E.week.signals} tín hiệu, ${E.week.resolved} có kết quả (đúng ${f1(E.week.accuracy)}%), ${E.week.trades} lệnh đóng (P&L ${E.week.pnl.toFixed(2)}$)`);
  for (const s of E.strategies) {
    L.push(`• <b>${s.name}</b>: tín hiệu đúng ${f1(s.accuracy)}% (${s.resolved} mẫu, khoảng 95% ${s.ci ? `${f1(s.ci[0])}–${f1(s.ci[1])}%` : '-'}) — backtest ${f1(s.expected)}% → ${s.verdict}`);
    if (s.fwd5 != null) L.push(`   Lợi nhuận 5 ngày so với rổ: ${pct(s.fwd5 / 100)} (${s.fwd5n} mẫu, backtest ${s.fwd5Exp == null ? '-' : pct(s.fwd5Exp / 100)})`);
  }
  L.push(`<b>Kết luận tạm:</b> ${E.overall}`);
  return L.join('\n');
}
