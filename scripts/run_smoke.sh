#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_HOST="${APP_HOST:-127.0.0.1}"
APP_PORT="${APP_PORT:-3000}"
API_PORT="${API_PORT:-11434}"
CHROME_BIN="${CHROME_BIN:-google-chrome}"
CHROME_TIMEOUT="${CHROME_TIMEOUT:-120s}"

APP_LOG="$(mktemp)"
API_LOG="$(mktemp)"
DOM_LOG="$(mktemp)"
USER_DATA_DIR="$(mktemp -d)"

cleanup() {
  if [[ -n "${APP_PID:-}" ]]; then kill "$APP_PID" >/dev/null 2>&1 || true; fi
  if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$USER_DATA_DIR"
  rm -f "$APP_LOG" "$API_LOG" "$DOM_LOG"
  wait "${APP_PID:-}" "${API_PID:-}" >/dev/null 2>&1 || true
}

trap cleanup EXIT

cd "$ROOT_DIR"
python3 -m http.server "$APP_PORT" --bind "$APP_HOST" >"$APP_LOG" 2>&1 &
APP_PID=$!
python3 scripts/mock_api.py "$API_PORT" >"$API_LOG" 2>&1 &
API_PID=$!

wait_for_url() {
  local label="$1"
  local url="$2"
  local log_file="$3"

  for _ in {1..50}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "Smoke test failed: ${label} did not become ready at ${url}."
  cat "$log_file"
  exit 1
}

wait_for_url "app server" "http://${APP_HOST}:${APP_PORT}/index.html" "$APP_LOG"
wait_for_url "mock API" "http://${APP_HOST}:${API_PORT}/v1/models" "$API_LOG"

chrome_args=(
  --headless=new
  --disable-gpu
  --no-sandbox
  --disable-dev-shm-usage
  --disable-breakpad
  --disable-crash-reporter
  --no-first-run
  --no-default-browser-check
  --user-data-dir="$USER_DATA_DIR"
  --virtual-time-budget=25000
  --dump-dom "http://${APP_HOST}:${APP_PORT}/tests/smoke.html"
)

set +e
if command -v timeout >/dev/null 2>&1; then
  timeout "$CHROME_TIMEOUT" "$CHROME_BIN" "${chrome_args[@]}" >"$DOM_LOG"
else
  "$CHROME_BIN" "${chrome_args[@]}" >"$DOM_LOG"
fi

chrome_status=$?
set -e
if [[ "$chrome_status" -ne 0 ]]; then
  echo "Smoke test failed: Chrome exited with status ${chrome_status}."
  cat "$DOM_LOG"
  exit "$chrome_status"
fi

if ! grep -q 'data-smoke-result="pass"' "$DOM_LOG"; then
  echo "Smoke test failed."
  cat "$DOM_LOG"
  exit 1
fi

echo "Smoke test passed."
