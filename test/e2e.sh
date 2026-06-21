#!/usr/bin/env bash
# Manual end-to-end smoke test.
# Requires an existing ~/.local/share/copilot-api/github_token.
set -e
PORT="${ADAPTER_PORT:-4198}"

echo "[WAIT] Starting adapter in the background"
node -e "import('./src/adapter.mjs').then(m=>m.startAdapter($PORT))" &
PID=$!
sleep 1

echo "[INFO] 1. GET /v1/models"
curl -s "http://localhost:$PORT/v1/models" | head -c 300; echo

echo "[INFO] 2. Chat-model Responses path (gpt-4o, streaming)"
curl -s -N -X POST "http://localhost:$PORT/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"input":"say hi in one word"}' | head -c 400; echo

echo "[INFO] 3. Check for unrelated copilot-api processes"
pgrep -f "copilot-api (start|auth)" >/dev/null && echo "[WARN] A copilot-api process exists (may be unrelated legacy)" || echo "[OK] No copilot-api child process detected"

echo "[INFO] 4. POST /v1/messages non-streaming"
curl -s -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","max_tokens":50,"messages":[{"role":"user","content":"say OK"}]}' | head -c 400; echo

echo "[INFO] 5. POST /v1/messages streaming"
curl -s -N -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"say OK"}]}' 2>&1 | grep -aE "^event:" | head -10; echo

echo "[INFO] 6. POST /v1/messages/count_tokens"
curl -s -X POST "http://localhost:$PORT/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"hello world how many tokens"}]}'; echo

kill $PID 2>/dev/null || true
echo "[OK] Done"
