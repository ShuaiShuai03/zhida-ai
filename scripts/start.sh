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

# Try python3 first, then python, then npx serve
if command -v python3 &>/dev/null; then
  echo "使用 Python 3 启动..."
  cd "$DIR" && python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
  echo "使用 Python 启动..."
  cd "$DIR" && python -m http.server "$PORT"
elif command -v npx &>/dev/null; then
  echo "使用 npx serve 启动..."
  cd "$DIR" && npx serve . -p "$PORT"
else
  echo "错误: 未找到 Python 或 Node.js。"
  echo "请安装以下任一工具:"
  echo "  - Python 3: https://www.python.org/downloads/"
  echo "  - Node.js:  https://nodejs.org/"
  exit 1
fi
