#!/usr/bin/env bash
# Manual end-to-end smoke test. Requires a saved GitHub Copilot token.
set -euo pipefail

PORT="${ADAPTER_PORT:-4198}"
BASE_URL="http://127.0.0.1:${PORT}"
PID=""
HEALTH=""
IMAGE_PAYLOAD_FILE=""

cleanup() {
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ -n "$IMAGE_PAYLOAD_FILE" ]]; then
    rm -f "$IMAGE_PAYLOAD_FILE"
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
IMAGE_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("gpt-") && x.capabilities?.supports?.vision === true && (x.supported_endpoints||[]).some(e => e === "/responses" || e === "/v1/responses")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
CHAT_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("gpt-") && (x.supported_endpoints||[]).includes("/chat/completions")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
CLAUDE_MODEL="$(node -e 'const d=JSON.parse(process.argv[1]).data||[]; const m=d.find(x => String(x.id||"").startsWith("claude-") && (x.supported_endpoints||[]).includes("/chat/completions")); if (!m) process.exit(1); process.stdout.write(m.id)' "$MODELS")"
echo "[OK] Models: responses=${RESPONSES_MODEL} image=${IMAGE_MODEL} chat=${CHAT_MODEL} claude=${CLAUDE_MODEL}"

DIRECT="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/responses" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${RESPONSES_MODEL}\",\"stream\":false,\"input\":\"reply with OK\"}")"
node -e 'const r=JSON.parse(process.argv[1]); if (!r.id || !Array.isArray(r.output)) process.exit(1)' "$DIRECT"
echo "[OK] Native Responses request passed"

DIRECT_ID="$(node -e 'const r=JSON.parse(process.argv[1]); process.stdout.write(r.id)' "$DIRECT")"
HISTORY_PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({model:process.argv[1],stream:false,previous_response_id:process.argv[2],input:"reply with OK again"}))' "$RESPONSES_MODEL" "$DIRECT_ID")"
HISTORY="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/responses" \
  -H 'Content-Type: application/json' \
  --data-binary "$HISTORY_PAYLOAD")"
node -e 'const r=JSON.parse(process.argv[1]); if (!r.id || !Array.isArray(r.output)) process.exit(1)' "$HISTORY"
echo "[OK] Local previous_response_id history passed"

COMPACT="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/responses/compact" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"${RESPONSES_MODEL}\",\"stream\":false,\"input\":\"compact this short context\"}")"
node -e 'const r=JSON.parse(process.argv[1]); if (!r.id || !Array.isArray(r.output)) process.exit(1)' "$COMPACT"
echo "[OK] Responses compaction passed"

IMAGE_PAYLOAD_FILE="$(mktemp "${TMPDIR:-/tmp}/ccdx-image-e2e.XXXXXX")"
node --input-type=module -e '
  import sharp from "sharp";
  const pixels = Buffer.alloc(256 * 256 * 3);
  let seed = 0x12345678;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = ((seed * 1664525) + 1013904223) >>> 0;
    pixels[index] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
  if (png.length <= 100000) process.exit(1);
  process.stdout.write(JSON.stringify({
    model: process.argv[1],
    stream: false,
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Reply with one word describing this image." },
      { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` },
    ] }],
  }));
' "$IMAGE_MODEL" > "$IMAGE_PAYLOAD_FILE"
IMAGE="$(curl -fsS --max-time 120 -X POST "${BASE_URL}/v1/responses" \
  -H 'Content-Type: application/json' \
  --data-binary "@${IMAGE_PAYLOAD_FILE}")"
node -e 'const r=JSON.parse(process.argv[1]); if (!r.id || !Array.isArray(r.output)) process.exit(1)' "$IMAGE"
echo "[OK] Compressed image Responses request passed"

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
