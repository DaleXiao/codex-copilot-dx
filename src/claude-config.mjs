import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// 纯函数：返回更新后的 settings 对象副本，只改 env.ANTHROPIC_BASE_URL。
// 不修改入参。changed 表示是否真的发生变化。
export function computeUpdatedSettings(settings, port) {
  const target = `http://localhost:${port}`;
  const current = settings?.env?.ANTHROPIC_BASE_URL;
  const changed = current !== target;
  const json = { ...settings, env: { ...(settings?.env || {}), ANTHROPIC_BASE_URL: target } };
  return { json, changed };
}

// 副作用包装：读 ~/.claude/settings.json，改写 ANTHROPIC_BASE_URL 指向 adapter 端口。
// 改前备份 .bak。文件不存在或解析失败则跳过（不破坏现有文件），仅提示用户手工配置。
export function ensureClaudeConfig(port = 8148) {
  const target = `http://localhost:${port}`;

  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log(`[codex-copilot-dx] 未找到 ~/.claude/settings.json，跳过。Claude Code 请手动设 ANTHROPIC_BASE_URL=${target}`);
    return;
  }

  let raw, settings;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    settings = JSON.parse(raw);
  } catch (e) {
    console.log(`[codex-copilot-dx] ~/.claude/settings.json 解析失败，跳过自动配置：${e.message}`);
    console.log(`  请手动设 ANTHROPIC_BASE_URL=${target}`);
    return;
  }

  const { json, changed } = computeUpdatedSettings(settings, port);
  if (!changed) {
    console.log(`[codex-copilot-dx] Claude Code 已指向 ${target}`);
    return;
  }

  fs.writeFileSync(`${SETTINGS_PATH}.bak`, raw);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(json, null, 2) + "\n");
  console.log(`[codex-copilot-dx] 已配置 Claude Code ANTHROPIC_BASE_URL = "${target}"（备份 settings.json.bak）`);
}
