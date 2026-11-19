import { SOURCE_HTTP_CONTEXT } from "./source-response.mjs";
import { currentRequestContext } from "./request-context.mjs";
import { markUpstreamStarted, markRequestObservation } from "./stream-performance.mjs";

const send = input => {
  input.onUpstreamStart?.();if (input.observe) { markUpstreamStarted(input.stream);if (input.evidence) markRequestObservation(input.evidence); }
  return input.send.apply(input.receiver, input.args);
};

// Providers call this after final wire serialization. Queues count the exact
// retained wire text and the HTTP client reuses it; admission does not serialize.
export function sourceTransport(options, input) {
  input.onUpstreamStart = options.onUpstreamStart;
  const context = options[SOURCE_HTTP_CONTEXT];
  if (!context || options.countTokens) return send(input);
  return context.scheduler.run(context.descriptor(), send, { args: input, signal: options.signal,
    model: input.model, client: currentRequestContext()?.application || "other", bodyText: input.bodyText, bytes: input.bodyBytes,
    sourceBodyManaged: options.sourceBodyManaged === true });
}
