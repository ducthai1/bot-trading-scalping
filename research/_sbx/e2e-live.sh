set -u
cd /app
export SWING_DATA_DIR=/tmp/e2e SWING_ADMIN_KEY=k SWING_PORT=3102 SWING_BINANCE_BASE=http://127.0.0.1:4000 SWING_WS_BASE=ws://127.0.0.1:4001
echo '{ "onTimeMinutes": 1440, "maxEntryDelayHours": 24 }' > swing/config.local.json
node _sbx/mock-binance.mjs & MOCK=$!; sleep 1
node swing/src/main.js --dry > /tmp/e2e.log 2>&1 & BOT=$!
sleep 14
echo "===== Log bot (rút gọn) ====="
grep -E "Realtime|Job ngày|Tín hiệu|VÀO LỆNH|bỏ qua|Kiểm chứng|chạm SL/TP|Breakout chạm|LINKUSDT \[Breakout\]|lỗi" /tmp/e2e.log | cut -c1-200 | head -30
echo; echo "===== /api/live ====="
wget -q -O /tmp/live.json http://127.0.0.1:3102/api/live && node -e "const L=JSON.parse(require('fs').readFileSync('/tmp/live.json'));console.log('feed',L.feed.status,'healthy',L.feed.healthy,'msgs',L.feed.messages,'bars',L.feed.bars);console.log('equity',L.equity.toFixed(2),'open',JSON.stringify(L.open.map(o=>[o.symbol,o.strategy,(o.ret*100).toFixed(2)+'%'])),'shadows',L.shadowsOpen,'queue',L.queue);console.log('watch top3',JSON.stringify(L.watch.rows.slice(0,3).map(r=>[r.symbol,r.provisional,r.r3,r.breakout,r.rsi2.toFixed(1),(r.toLevel*100).toFixed(1)+'%'])))"
echo; echo "===== /api/report: kiểm chứng ====="
wget -q -O /tmp/rep.json http://127.0.0.1:3102/api/report && node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/rep.json'));console.log('trades',JSON.stringify(r.trades.map(t=>[t.symbol,t.reason,(t.ret*100).toFixed(2)+'%'])));console.log('signals',JSON.stringify(r.signals.map(s=>[s.id,s.symbol,s.strategy,s.status,s.result?s.result.reason+' '+(s.result.ret*100).toFixed(2)+'%':'đang theo dõi'])));console.log('evaluation:',r.evaluation.overall);console.log('forward rows',r.forward.length)"
kill -TERM $BOT; sleep 2; kill $MOCK; rm -f swing/config.local.json
echo; tail -3 /tmp/e2e.log
