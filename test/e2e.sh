#!/usr/bin/env bash
# 手动端到端验证。前提：已登录（~/.local/share/copilot-api/github_token 存在）。
# 用一个不冲突的端口，避免撞上遗留进程。
set -e
PORT="${ADAPTER_PORT:-4198}"

echo "=== 启动 adapter（后台）==="
node -e "import('./src/adapter.mjs').then(m=>m.startAdapter($PORT))" &
PID=$!
sleep 1

echo "=== 1. GET /v1/models ==="
curl -s "http://localhost:$PORT/v1/models" | head -c 300; echo

echo "=== 2. 老模型 chat 路径（gpt-4o，流式）==="
curl -s -N -X POST "http://localhost:$PORT/v1/responses" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","stream":true,"input":"say hi in one word"}' | head -c 400; echo

echo "=== 3. 确认 OUR adapter 进程未派生 copilot-api 子进程 ==="
pgrep -f "copilot-api (start|auth)" >/dev/null && echo "WARN: a copilot-api process exists (may be unrelated legacy)" || echo "OK: 无 copilot-api 子进程"

echo "=== 4. POST /v1/messages 非流式 ==="
curl -s -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","max_tokens":50,"messages":[{"role":"user","content":"say OK"}]}' | head -c 400; echo

echo "=== 5. POST /v1/messages 流式 ==="
curl -s -N -X POST "http://localhost:$PORT/v1/messages" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"say OK"}]}' 2>&1 | grep -aE "^event:" | head -10; echo

echo "=== 6. POST /v1/messages/count_tokens ==="
curl -s -X POST "http://localhost:$PORT/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello world how many tokens"}]}'; echo

kill $PID 2>/dev/null || true
echo "=== done ==="
