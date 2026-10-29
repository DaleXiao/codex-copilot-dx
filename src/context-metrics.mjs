import { createHmac, randomBytes } from "node:crypto";
import { currentRequestContext } from "./request-context.mjs";

const salt = randomBytes(32);
const bounded = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Presentation-only correlation. Never infer identity from prompts or retain an ID.
export function observeContextSession(body, headers = {}, provider, protocol = "responses") {
  const tracker = currentRequestContext()?.streamPerformance;
  if (!tracker?.observeSession) return;
  let session = headers.session_id || headers["session-id"] || headers["x-conversation-id"] || headers["x-claude-code-session-id"];
  if (!session && typeof body?.metadata?.user_id === "string" && body.metadata.user_id.length <= 2048) {
    try { session = JSON.parse(body.metadata.user_id)?.session_id; }
    catch { session = /(?:^|_)session_([\w-]{8,128})$/.exec(body.metadata.user_id)?.[1]; }
  }
  if (!bounded(session)) return;
  try {
    const profile = provider?.profileId?.(protocol);
    if (!bounded(profile)) return;
    const agent = headers["x-claude-code-agent-id"];
    const key = createHmac("sha256", salt).update(`${profile}\0${session}\0${bounded(agent) ? agent : ""}`).digest("hex");
    tracker.observeSession(key);
  } catch { /* Optional metadata cannot change request admission or routing. */ }
}

export function createContextMetrics() {
  const sessions = new Map(), unassigned = [];
  let sequence = 0;
  return {
    record({ session, application, provider, model, route, at, started, finished, request_id, outcome, context, cached_input_tokens }) {
      const input = count(context.input_tokens), cached = count(cached_input_tokens);
      const point = { at, order: started, request_id, outcome, input_tokens: input,
        context_window_tokens: count(context.context_window_tokens) || null,
        cached_input_tokens: input !== null && cached !== null && cached <= input ? cached : null,
        elapsed_ms: Math.max(0, finished - started), finished };
      const compact = route === "responses_compact";
      if (!session) {
        unassigned.push({ id: `request-${++sequence}`, application, provider, model, ...point, compact });
        if (unassigned.length > 20) unassigned.shift();
        return;
      }
      const key = `${application}\0${provider}\0${model}\0${session}`;
      let entry = sessions.get(key);
      if (!entry) entry = { id: `session-${++sequence}`, application, provider, model, points: [], compactions: [] };
      sessions.delete(key);sessions.set(key, entry);
      const list = compact ? entry.compactions : entry.points;
      list.push(point);if (list.length > (compact ? 16 : 64)) list.shift();
      if (sessions.size > 64) sessions.delete(sessions.keys().next().value);
    },
    snapshot() {
      const project = entry => {
        const points = entry.points.map(point => ({ ...point })).sort((a, b) => a.order - b.order);
        let end = -Infinity, concurrent = false;
        for (const point of points) { if (point.order < end) concurrent = true;end = Math.max(end, point.finished); }
        return { ...entry, points, concurrent, compactions: entry.compactions.map(point => ({ ...point })).sort((a, b) => a.order - b.order) };
      };
      return { source: "run_context", sessions: [...sessions.values()].reverse().map(project),
        unassigned: unassigned.slice().reverse().map(point => ({ ...point })),
        limits: { sessions: 64, points: 64, compactions: 16, unassigned: 20 } };
    },
  };
}
