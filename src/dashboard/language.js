(() => {
  const translations = {
    "CCDX · Local dashboard": "CCDX · 本地看板",
    "/ LOCAL STATUS": "/ 本地状态",
    "READING": "读取中",
    "LOCAL OK": "本机正常",
    "UNAVAILABLE": "不可用",
    "Refresh": "刷新",
    "Animation": "动效",
    "Switch to light mode": "切换为日间模式",
    "Switch to dark mode": "切换为夜间模式",
    "Overview": "概览",
    "Runtime details": "运行详情",
    "ADAPTER": "适配服务",
    "KNOWN MODELS": "已知模型",
    "REQUESTS": "请求",
    "Per-request limits (active)": "单次请求上限（当前）",
    "MODEL OUTCOMES": "模型终态",
    "Completed": "已完成",
    "Incomplete": "未完成",
    "Failed": "失败",
    "Cancelled": "已取消",
    "HTTP 2xx != model completed.": "HTTP 2xx 不代表模型已完成。",
    "LOCAL HISTORY": "本机历史缓存",
    "ACTIVE LIMIT": "当前上限",
    "History cache usage": "历史缓存用量",
    "IMAGE GENERATION": "图片生成",
    "OPTIONAL": "可选功能",
    "Live upstream models": "上游在线模型",
    "UPSTREAM GPT MODELS": "上游 GPT 模型",
    "CHECKING LIVE": "在线查询中",
    "Querying GitHub Copilot…": "正在查询 GitHub Copilot…",
    "MODEL": "模型",
    "VENDOR": "提供方",
    "FLAG": "标记",
    "Loading…": "加载中…",
    "Catalog listing does not guarantee inference access.": "模型出现在目录中，不代表当前账号可调用它。",
    "Usage by model": "模型用量",
    "USAGE": "用量",
    "READING LOG": "读取日志中",
    "All history": "全部历史",
    "Aggregating local usage metadata…": "正在汇总本机用量记录…",
    "CALLS": "调用次数",
    "INPUT": "输入",
    "CACHE READ": "缓存读取",
    "OUTPUT": "输出",
    "TOTAL": "合计",
    "CACHE HIT": "缓存命中率",
    "Cache hit = recorded cached / input tokens. ~ = incomplete history. — = unavailable or invalid counts.": "命中率 = 已记录的缓存输入 / 输入 Token。~ 表示历史不完整；— 表示数据不可用或无效。",
    "USAGE ANALYTICS": "用量分析",
    "Model": "模型",
    "All models": "全部模型",
    "Daily range": "统计范围",
    "7 days": "7 天",
    "30 days": "30 天",
    "90 days": "90 天",
    "Activity": "活跃指标",
    "Calls": "调用次数",
    "Tokens": "Token 数",
    "Open to read retained usage history.": "展开后读取已保留的用量历史。",
    "DAILY TOKENS": "每日 Token 用量",
    "INPUT + OUTPUT / CACHE INCLUDED IN INPUT": "输入 + 输出 / 缓存已包含在输入中",
    "Daily token usage": "每日 Token 用量",
    "Input": "输入",
    "Output": "输出",
    "REQUEST ACTIVITY · 365 DAYS": "调用热力图 · 365 天",
    "Daily recorded request activity": "每日已记录的调用次数",
    "Select a day to inspect its model totals. No history is distinct from zero recorded calls.": "点击日期查看模型用量。无留存历史不等于零次调用。",
    "Recent failures": "近期失败",
    "RECENT UPSTREAM FAILURES": "近期上游失败",
    "Reading…": "读取中…",
    "Reading status…": "正在读取状态…",
    "Upstream messages may contain sensitive text.": "上游错误信息可能含敏感内容。",
    "TERMINAL ANIMATION": "终端动效",
    "Animation theme": "动效主题",
    "Save selection": "保存选择",
    "Applies on next ccdx start.": "下次启动 ccdx 时生效。",
    "LOCAL ONLY / NO BACKGROUND POLLING": "仅限本机 / 无后台轮询",
    "Saved GitHub Copilot account / local credentials only; not an online entitlement check.": "已保存的 GitHub Copilot 账号；仅读取本机凭据，不代表在线权限验证。",
    "GitHub / READING": "GitHub / 读取中",
    "GitHub / UNAVAILABLE": "GitHub / 不可用",
    "GitHub / NOT CONFIGURED": "GitHub / 未配置",
    "GitHub / INVALID": "GitHub / 无效",
    "GitHub / {account} / SAVED": "GitHub / {account} / 已保存",
    "account unknown": "账号未知",
    "pid {pid} / uptime {duration}": "PID {pid} / 运行时间 {duration}",
    "BOUND": "已绑定",
    "UNCONFIRMED": "未确认",
    "service token / TTL {duration}": "服务令牌 / 剩余有效期 {duration}",
    "service token not cached": "服务令牌未缓存",
    "source {source} / live: ccdx models": "来源 {source} / 在线目录：ccdx models",
    "built-in": "内置",
    "cache": "缓存",
    "live": "在线",
    "unknown": "未知",
    "4xx {client} / 5xx {server} / active {active}": "4xx {client} / 5xx {server} / 进行中 {active}",
    "raw {raw} / decoded {decoded}": "原始 {raw} / 解码后 {decoded}",
    "entries {entries} / trees {trees} / misses {misses} (evicted {evicted})": "记录 {entries} / 历史树 {trees} / 未命中 {misses}（已淘汰 {evicted}）",
    "{count} succeeded": "成功 {count} 次",
    "NOT INITIALIZED": "未初始化",
    "active {active} / failed {failed} / delivery failures {delivery}": "进行中 {active} / 失败 {failed} / 交付失败 {delivery}",
    "Setup state unknown / ccdx image-status": "配置状态未知 / ccdx image-status",
    "Snapshot {time}": "快照 {time}",
    "Status unavailable / check ccdx, then refresh": "状态不可用 / 请检查 ccdx 后刷新",
    "{count} retained / response.failed": "保留 {count} 条 / response.failed",
    "No response.failed events recorded.": "未记录 response.failed 事件。",
    "{detail} / {retry}": "{detail} / {retry}",
    "retry attempted": "已尝试重试",
    "no retry": "未重试",
    "time": "时间",
    "model": "模型",
    "event": "事件",
    "code": "错误码",
    "message": "错误信息",
    "response_id": "响应 ID",
    "upstream_request_id": "上游请求 ID",
    "retry": "重试",
    "retry_policy": "重试策略",
    "retry_skipped": "跳过重试原因",
    "attempted (outcome not recorded here)": "已尝试（此处未记录结果）",
    "not attempted": "未尝试",
    "Copy diagnostic": "复制诊断信息",
    "Copied": "已复制",
    "Copy unavailable": "无法复制",
    "DEFAULT": "默认",
    "Disabled by CCDX_TERMINAL_ANIMATION; saved choice applies after override removal and next start.": "CCDX_TERMINAL_ANIMATION 已禁用动效；移除覆盖设置后，保存的选择在下次启动时生效。",
    "Saved choice applies on next ccdx start.": "保存的选择在下次启动 ccdx 时生效。",
    "CURRENT {theme}{unsaved}": "当前 {theme}{unsaved}",
    " / UNSAVED": " / 未保存",
    "Saving…": "保存中…",
    "Not saved / {error}": "未保存 / {error}",
    "preview": "预览版",
    "No selectable GPT models advertised.": "上游未提供可选的 GPT 模型。",
    "LIVE SNAPSHOT": "在线快照",
    "{selectable} selectable / {advertised} advertised / {host} / {time}": "可选 {selectable} / 上游提供 {advertised} / {host} / {time}",
    "LIVE LOOKUP FAILED": "在线查询失败",
    "No live catalog available.": "在线模型目录不可用。",
    "No usage records.": "暂无用量记录。",
    "LOCAL LOG": "本机日志",
    "{records} records / {shown} of {models} models shown{day}": "记录 {records} 条 / 展示 {shown} 个模型，共 {models} 个{day}",
    " / {zone} / {model}": " / {zone} / {model}",
    "no retained history": "无留存历史",
    "{calls} recorded calls / input {input} / output {output} / cached {cached} (included in input){partial}": "记录 {calls} 次调用 / 输入 {input} / 输出 {output} / 缓存 {cached}（已包含在输入中）{partial}",
    " / partial token counts": " / Token 数据不完整",
    "{date} / {description}": "{date} / {description}",
    "{metric} / PEAK {peak}": "{metric} / 峰值 {peak}",
    "INPUT + OUTPUT": "输入 + 输出",
    "RECORDED CALLS": "已记录调用",
    "{zone} / {from} — {to} / retained history starts {first}; oldest day may be partial.{excluded}{limit}": "{zone} / {from} — {to} / 留存历史始于 {first}；最早一天的数据可能不完整。{excluded}{limit}",
    " {count} records with invalid/future timestamps excluded.": " 已排除 {count} 条时间无效或位于未来的记录。",
    " Model filters limited to 100; all-model totals include the remainder.": " 模型筛选最多展示 100 个模型；全部模型合计包含其余模型。",
    "Selected {date} / {model}: totals in the Usage table above / All history resets the table.": "已选 {date} / {model}：用量见上方表格 / 点击“全部历史”恢复总表。",
    "Select a day for model totals. Calls are usage records, not messages or time. Hatched cells: no retained history; empty cells: zero recorded calls.": "点击日期查看模型用量。调用次数来自用量记录，不代表消息数或时长。斜线格表示无留存历史；空白格表示零次已记录调用。",
    "LOG UNAVAILABLE": "日志不可用",
    "No usage summary available.": "用量汇总不可用。",
    "Analytics unavailable / refresh Usage to retry.": "分析不可用 / 请刷新用量后重试。",
    "Animation settings are invalid; inspect them with ccdx animation": "动效设置无效；请运行 ccdx animation 检查。",
    "Animation setting was not saved; check ccdx animation": "动效设置未保存；请运行 ccdx animation 检查。",
    "Could not read local usage summary": "无法读取本机用量汇总。",
    "Live model lookup timed out. Retry or run ccdx models.": "在线模型查询超时；请重试或运行 ccdx models。",
    "GitHub token not found. Start ccdx to sign in.": "未找到 GitHub 令牌；请启动 ccdx 登录。",
    "Live model lookup failed. Run ccdx models for details.": "在线模型查询失败；请运行 ccdx models 查看详情。",
  };
  const storageKey = "ccdx.dashboard.language";
  let language = "en";
  try { if (localStorage.getItem(storageKey) === "zh") language = "zh"; } catch {}
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  const messages = new WeakMap();
  const attributes = { textContent: "data-i18n", title: "data-i18n-title", "aria-label": "data-i18n-label" };

  function format(key, values = {}) {
    const template = language === "zh" ? translations[key] || key : key;
    return String(template).replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.hasOwn(values, name)) return match;
      const value = values[name];
      return value && typeof value === "object" && typeof value.key === "string"
        ? format(value.key, value.values) : String(value ?? "");
    });
  }

  function set(target, key, values = {}, attribute = "textContent") {
    const saved = messages.get(target) || {};
    saved[attribute] = { key, values };
    messages.set(target, saved);
    target.setAttribute(attributes[attribute], "");
    const value = format(key, values);
    if (attribute === "textContent") target.textContent = value;
    else target.setAttribute(attribute, value);
  }

  function apply() {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    for (const target of document.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-label]")) {
      for (const [attribute, marker] of Object.entries(attributes)) {
        if (!target.hasAttribute(marker)) continue;
        const saved = messages.get(target)?.[attribute];
        set(target, saved?.key ?? (attribute === "textContent" ? target.textContent : target.getAttribute(attribute)), saved?.values, attribute);
      }
    }
    const button = document.getElementById("language-toggle");
    button.textContent = language === "en" ? "中文" : "EN";
    const label = language === "en" ? "Switch to Chinese" : "切换为英文";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  globalThis.ccdxLanguage = { set, format };
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("language-toggle").addEventListener("click", () => {
      language = language === "en" ? "zh" : "en";
      try { localStorage.setItem(storageKey, language); } catch {}
      apply();
    });
  });
})();
