// Diagnostics are not a copy of the upstream payload. Keep useful error text,
// but remove common credential forms and explicitly labelled content echoes.
export function redactDiagnosticText(value) {
  return String(value ?? "")
    .replace(/(\b(?:proxy[-_]?)?authorization["']?\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s,;"'<>\\]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+([^\s,;"'<>\\]+)/gi, (match, scheme, value) => {
      // Standalone ordinary prose such as "basic authentication" is not a credential.
      if (scheme.toLowerCase() === "basic"
        && (!/^[a-z0-9+/_-]+={0,2}$/i.test(value) || !Buffer.from(value, "base64").includes(0x3a))) return match;
      return `${scheme} [redacted]`;
    })
    .replace(/\b([a-z][a-z0-9+.-]{0,63}:\/\/)[^\s/?#"'<>]*@/gi, "$1[redacted]@")
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-|copilot_)[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/((?:prompt|input|completion|tool_arguments|arguments|content)["']?\s*[:=]\s*)[^\n]+/gi, "$1[redacted]")
    .replace(/(encrypted(?: function output)? content\s+)[A-Za-z0-9+/_=-]{24,}/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9+/_=-]{96,}\b/g, "[redacted]");
}
