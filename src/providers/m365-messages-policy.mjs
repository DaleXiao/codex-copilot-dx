// Loki explicitly rejects 1h prompt-cache retention. Cap only the standard
// cache_control locations to its supported 5m TTL; never walk tool input/data.
// Text, image bytes, thinking, tools, permissions and cache breakpoints survive.
export function limitM365CacheTtl(body) {
  let changed = 0;
  const block = value => {
    if (value?.cache_control?.type !== "ephemeral" || value.cache_control.ttl !== "1h") return value;
    changed++;return { ...value, cache_control: { ...value.cache_control, ttl: "5m" } };
  };
  const blocks = value => {
    if (!Array.isArray(value)) return value;
    const before = changed, next = value.map(block);return changed === before ? value : next;
  };
  const next = block(body);
  const system = blocks(body.system), tools = blocks(body.tools);
  const messages = Array.isArray(body.messages) ? body.messages.map(message => {
    const content = blocks(message?.content);return content === message?.content ? message : { ...message, content };
  }) : body.messages;
  return { body: changed ? { ...next, system, tools, messages } : body, changed };
}
