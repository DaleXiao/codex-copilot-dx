#!/usr/bin/env bash
# Manual end-to-end smoke test. Requires a saved GitHub Copilot token.
set -euo pipefail

PORT="${ADAPTER_PORT:-4198}"
BASE_URL="http://127.0.0.1:${PORT}"
PID=""
HEALTH=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[WAIT] Starting adapter in the background"
node -e "import('./src/adapter.mjs').then(m => m.startAdapter(${PORT}))" &
PID=$!

for _ in {1..50}; do
  if HEALTH="$(curl -fsS --max-time 1 "${BASE_URL}/_ccdx/health" 2>/dev/null)"; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[ERR] Adapter exited before becoming ready" >&2
    exit 1
  fi
  sleep 0.1
done

if ! kill -0 "$PID" 2>/dev/null; then
  echo "[ERR] Adapter process is not running" >&2
  exit 1
fi
if [[ -z "$HEALTH" ]]; then
  echo "[ERR] Adapter did not become healthy" >&2
  exit 1
fi
node -e 'const h=JSON.parse(process.argv[1]); const p=require("./package.json"); if (h.ok !== true || h.name !== "codex-copilot-dx" || h.version !== p.version) process.exit(1)' "$HEALTH"
echo "[OK] Adapter health check passed"

MODELS="$(curl -fsS --max-time 30 "${BASE_URL}/v1/models")"
RESPONSES_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("gpt-") && (x.supported_endpoints||[]).some(e => e === "/responses" || e === "/v1/responses")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
CHAT_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("gpt-") && (x.supported_endpoints||[]).includes("/chat/completions")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
CLAUDE_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("claude-") && (x.supported_endpoints||[]).includes("/chat/completions")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
echo "[OK] Models: responses=${RESPONSES_MODEL} chat=${CHAT_MODEL} claude=${CLAUDE_MODEL}"

DIRECT="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${RESPONSES_MODEL}\",\"stream\":false,\"input\":\"reply with OK\"}")"
node -e 'const r=JSON.parse(process.argv[1]); if (!r.id || !Array.isArray(r.output)) process.exit(1)' "$DIRECT"
echo "[OK] Native Responses request passed"

RESPONSE_STREAM="$(curl -fsS -N --max-time 120 -X POST "${BASE_URL}/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${CHAT_MODEL}\",\"stream\":true,\"input\":\"reply with OK\"}")"
grep -q '^event: response.completed' <<<"$RESPONSE_STREAM"
echo "[OK] Converted Responses stream passed"

MESSAGE="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/messages" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${CLAUDE_MODEL}\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"reply with OK\"}]}")"
node -e 'const r=JSON.parse(process.argv[1]); if (r.type !== "message" || !Array.isArray(r.content)) process.exit(1)' "$MESSAGE"
echo "[OK] Non-streaming Messages request passed"

MESSAGE_STREAM="$(curl -fsS -N --max-time 120 -X POST "${BASE_URL}/v1/messages" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${CLAUDE_MODEL}\",\"max_tokens\":16,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"reply with OK\"}]}")"
grep -q '^event: message_stop' <<<"$MESSAGE_STREAM"
echo "[OK] Streaming Messages request passed"

COUNT="$(curl -fsS --max-time 30 -X POST "${BASE_URL}/v1/messages/count_tokens" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${CLAUDE_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"hello world\"}]}")"
node -e 'const r=JSON.parse(process.argv[1]); if (!(r.input_tokens > 0)) process.exit(1)' "$COUNT"
echo "[OK] Token counting passed"

echo "[OK] End-to-end smoke test passed"
