#!/usr/bin/env bash
# 智答 AI — 本地启动脚本 (macOS / Linux)
set -euo pipefail

PORT="${1:-3000}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================"
echo "  智答 AI — 本地开发服务器"
echo "============================================"
echo ""
echo "  项目目录: $DIR"
echo "  访问地址: http://localhost:$PORT"
echo "  按 Ctrl+C 停止"
echo ""

port_report=""
if command -v ss >/dev/null 2>&1; then
  port_report="$(ss -ltnp "sport = :$PORT" 2>/dev/null || true)"
  if [[ "$(printf '%s\n' "$port_report" | sed '/^[[:space:]]*$/d' | wc -l)" -gt 1 ]]; then
    echo "错误: 端口 $PORT 已被占用。"
    echo "$port_report"
    echo ""
    echo "请停止旧进程，或使用其他端口，例如: bash scripts/start.sh 3001"
    exit 1
  fi
elif command -v lsof >/dev/null 2>&1; then
  port_report="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$port_report" ]]; then
    echo "错误: 端口 $PORT 已被占用。"
    echo "$port_report"
    echo ""
    echo "请停止旧进程，或使用其他端口，例如: bash scripts/start.sh 3001"
    exit 1
  fi
fi

if [[ -z "${ZHIDA_CONFIG_SECRET:-}" ]]; then
  echo "错误: 请先设置 ZHIDA_CONFIG_SECRET，用于加密保存 API 密钥。"
  echo "示例: ZHIDA_CONFIG_SECRET=\"change-this-to-a-long-random-secret\" bash scripts/start.sh $PORT"
  exit 1
fi

if command -v node &>/dev/null; then
  echo "使用 Node 后端代理启动..."
  cd "$DIR" && ZHIDA_PORT="$PORT" node server/server.js
else
  echo "错误: 未找到 Node.js。"
  echo "请安装 Node.js 18 或更高版本: https://nodejs.org/"
  exit 1
fi
