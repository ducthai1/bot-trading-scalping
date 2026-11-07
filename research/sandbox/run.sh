#!/bin/bash
# Chạy 1 lệnh trong container cách ly với bản copy hiện tại của repo (+ thư mục công cụ _sbx).
#   bash run.sh [--net] [--name <container>] [--repo <dir>] -- <lệnh shell>
# Mặc định KHÔNG có mạng. --net bật mạng (cho tải dữ liệu / WebSocket).
# Container: không mount thư mục host, không SSH key/agent, user thường, bỏ mọi capability, tự xoá khi xong.
set -e
export COPYFILE_DISABLE=1  # không đóng gói file ._ (xattr macOS)
NET=(--network none)
NAME=()
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HERE/../.."          # repo root
SBX="$HERE/.."              # research/ (contains _sbx)
while [ $# -gt 0 ]; do
  case "$1" in
    --net) NET=(); shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --name) NAME=(--name "$2"); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
(cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -cf - -T -) \
  | tar -cf - @- -C "$SBX" _sbx \
  | docker run --rm -i \
      --label ducthai.sandbox=1 \
      "${NET[@]}" "${NAME[@]}" \
      --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 256 --memory 1g --cpus 2 \
      ducthai-sandbox:base sh -c "tar -xf - -C /app && cd /app && $*"
