import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");

export function ensureCodexConfig(adapterPort = 4142) {
  const baseUrl = `http://localhost:${adapterPort}/v1`;

  if (!fs.existsSync(CONFIG_PATH)) {
    // Codex not installed yet, create minimal config
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `openai_base_url = "${baseUrl}"\n`);
    console.log("[codex-copilot-dx] Created ~/.codex/config.toml");
    return;
  }

  let content = fs.readFileSync(CONFIG_PATH, "utf-8");

  if (content.includes("openai_base_url")) {
    // Update existing
    content = content.replace(
      /openai_base_url\s*=\s*"[^"]*"/,
      `openai_base_url = "${baseUrl}"`,
    );
  } else {
    // Add at top of file
    content = `openai_base_url = "${baseUrl}"\n` + content;
  }

  fs.writeFileSync(CONFIG_PATH, content);
  console.log(`[codex-copilot-dx] Configured openai_base_url = "${baseUrl}"`);
}
