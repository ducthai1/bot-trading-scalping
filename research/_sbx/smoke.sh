set -u
cd /app
export SWING_DATA_DIR=/tmp/swingdata SWING_ADMIN_KEY=k123 SWING_PORT=3100
echo "===== 1) Lần chạy đầu: --once --dry ====="
node swing/src/main.js --once --dry 2>&1 | tail -30; echo "exit=$?"
echo; echo "--- files:"; ls -la /tmp/swingdata
echo; echo "===== 2) Chạy nền + gọi API ====="
node swing/src/main.js --dry > /tmp/bot.log 2>&1 &
BOT=$!; sleep 6
cget() { wget -q -S -O /tmp/out "http://127.0.0.1:3100$1" 2>&1 | grep -m1 HTTP/ | tr -d '\n'; echo " $1 -> $(head -c ${2:-160} /tmp/out | tr '\n' ' ')"; }
cpost() { wget -q -S -O /tmp/out --post-data="" ${2:+--header="x-admin-key: $2"} "http://127.0.0.1:3100$1" 2>&1 | grep -m1 HTTP/ | tr -d '\n'; echo " POST $1 key=${2:-none} -> $(head -c 160 /tmp/out)"; }
cget /health 300
cget / 80
cget /api/report 120
node -e "const r=require('/tmp/out.json'||0)" 2>/dev/null; wget -q -O /tmp/report.json http://127.0.0.1:3100/api/report && node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/report.json'));console.log('report keys:',Object.keys(r).join(','));console.log('summary:',JSON.stringify(r.summary).slice(0,400));console.log('signals:',r.signals.length,'open:',r.open.length,'accuracy rows:',r.accuracy.byDecision.length)"
cget /api/signals.csv 300
cget /api/trades.csv 200
cget /api/equity.csv 200
cpost /api/admin/run
cpost /api/admin/run wrongkey
cpost /api/admin/test-telegram k123
cpost /api/admin/run k123
cpost /api/admin/reset-breaker k123
echo; echo "===== 3) Khởi động bản thứ 2 cùng lúc ====="
node swing/src/main.js --dry 2>&1 | tail -2; echo "exit=$?"
echo; echo "===== 4) SIGTERM ====="
kill -TERM $BOT; sleep 2; if kill -0 $BOT 2>/dev/null; then echo "VẪN CHẠY"; else echo "đã dừng"; fi; ls /tmp/swingdata/bot.lock 2>/dev/null && echo "LOCK CÒN" || echo "lock đã gỡ"
tail -5 /tmp/bot.log
echo; echo "===== 5) Giả lập máy tắt 3 ngày ====="
node -e "const f='/tmp/swingdata/state.json';const s=JSON.parse(require('fs').readFileSync(f));s.lastClosedDay-=3*86400e3;s.lastOpenedDay-=3*86400e3;require('fs').writeFileSync(f,JSON.stringify(s))"
node swing/src/main.js --once --dry 2>&1 | grep -E "Job ngày|chạy bù|Bot đã không chạy|Vốn|MUA|BÁN|bỏ qua|không vào lệnh" | head -12; echo "exit=$?"
