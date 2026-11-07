set -u
cd /app
export SWING_DATA_DIR=/tmp/itest SWING_ADMIN_KEY=k SWING_PORT=3101 SWING_BINANCE_BASE=http://127.0.0.1:4000
# ép "đúng giờ" để test luồng mua (test chạy giữa ngày); bản thật dùng config gốc
echo '{ "onTimeMinutes": 1440, "maxEntryDelayHours": 24 }' > swing/config.local.json
node _sbx/mock-binance.mjs & MOCK=$!; sleep 1
echo "===== A) Job ngày: kỳ vọng R3 mua AAVE, Breakout mua LINK ====="
node swing/src/main.js --once --dry 2>&1 | sed -n '/telegram dry/,$p'
echo; echo "--- state:"; node -e "const s=JSON.parse(require('fs').readFileSync('/tmp/itest/state.json'));console.log('cash',s.cash.toFixed(4),'equity',s.equity,'positions',s.positions.map(p=>[p.strategy,p.symbol,+p.qty,+p.entryPx.toFixed(4),p.sl&&+p.sl.toFixed(4),p.tp&&+p.tp.toFixed(4)]),'shadows',s.shadows.length,'pending',JSON.stringify(s.pending))"
echo; echo "===== B) Job giờ: LINK tăng 30% lúc 10:00 → phải chạm TP ====="
node swing/src/main.js --dry > /tmp/it.log 2>&1 & BOT=$!; sleep 5
wget -q -O- --post-data="" --header="x-admin-key: k" http://127.0.0.1:3101/api/admin/run; echo
sleep 1; grep -A3 "Breakout chạm" /tmp/it.log
wget -q -O /tmp/r.json http://127.0.0.1:3101/api/report && node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/r.json'));console.log('trades:',r.trades.map(t=>[t.symbol,t.reason,(t.ret*100).toFixed(2)+'%',t.R&&t.R.toFixed(2)+'R']));console.log('open:',r.open.map(p=>[p.symbol,p.strategy,(p.ret*100).toFixed(2)+'%']));console.log('byStrategy BO:',JSON.stringify(r.byStrategy.BREAKOUT));console.log('signals:',r.signals.map(s=>[s.symbol,s.strategy,s.status,s.result?s.result.reason:'open']))"
kill -TERM $BOT; sleep 2
echo; echo "===== C) Binance trả 418 (ban IP): bot phải dừng request, giữ nguyên sổ ====="
kill $MOCK; sleep 0.5; MODE=ban node _sbx/mock-binance.mjs & MOCK=$!; sleep 1
cp /tmp/itest/state.json /tmp/state.before
node -e "const f='/tmp/itest/state.json';const s=JSON.parse(require('fs').readFileSync(f));s.lastClosedDay-=86400e3;s.lastOpenedDay-=86400e3;require('fs').writeFileSync(f,JSON.stringify(s))"
cp /tmp/itest/state.json /tmp/state.before
node swing/src/main.js --once --dry 2>&1 | grep -E "lỗi|418|thử lại" | head -3; echo "exit(node)=$(node swing/src/main.js --once --dry >/dev/null 2>&1; echo $?)"
wget -q -O- http://127.0.0.1:4000/__count; echo " (tổng request tới mock)"
cmp -s /tmp/state.before /tmp/itest/state.json && echo "✅ sổ không thay đổi sau lỗi" || echo "❌ sổ bị thay đổi"
kill $MOCK; rm -f swing/config.local.json
echo; echo "===== D) Khởi động lại ngay sau khi bị ban: không được gọi Binance tới khi hết hạn ====="
node _sbx/mock-binance.mjs & MOCK=$!; sleep 1
echo '{ "onTimeMinutes": 1440, "maxEntryDelayHours": 24 }' > swing/config.local.json
cat /tmp/itest/net.json; echo
node swing/src/main.js --once --dry 2>&1 | grep -E "lỗi" | head -1
wget -q -O- http://127.0.0.1:4000/__count; echo " (request tới mock mới — chỉ tính /__count là đúng)"
kill $MOCK; rm -f swing/config.local.json
