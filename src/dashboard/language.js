(() => {
  const translations = {
    "First output": ["First output", "首次输出"],
    "Token time": ["Token time", "输出耗时"],
    "Gateway timing. Token time is estimated.": ["Observed at the gateway. Token time is an estimate.", "网关观测时间。\n每Token耗时为估算值。"],
    "{value} / {samples} samples": ["{value} / {samples} samples", "{value} / {samples}次样本"],
    "CCDX · Local dashboard": ["CCDX · Dashboard", "CCDX · 运行看板"],
    "/ LOCAL STATUS": ["/ DASHBOARD", "/ 运行看板"],
    "READING": ["READING", "读取中"],
    "LOCAL OK": ["LOCAL OK", "本机正常"],
    "UNAVAILABLE": ["UNAVAILABLE", "无法读取"],
    "Refresh": ["Refresh", "刷新"],
    "Animation": ["Animation", "动效"],
    "Switch to light mode": ["Light mode", "白天模式"],
    "Switch to dark mode": ["Dark mode", "夜间模式"],
    "Overview": ["Overview", "概览"],
    "RECENT REQUEST CONTEXT": ["RECENT REQUESTS", "近期请求"],
    "WIRE MiB": ["DATA SIZE", "数据大小"],
    "IMAGES": ["IMAGES", "图片数量"],
    "INPUT TOKENS": ["INPUT USAGE", "输入用量"],
    "MODEL WINDOW": ["MODEL CAPACITY", "模型容量"],
    "INPUT / WINDOW": ["CAPACITY USED", "占用比例"],
    "OUTCOME": ["RESULT", "结果"],
    "Unknown": ["Unknown", "未知"],
    "No observed request metadata.": ["No request records yet.", "暂未收到请求记录。"],
    "20 latest finished requests / compactions: {completed} completed, {incomplete} incomplete, {failed} failed": ["Last 20 finished requests.\nHistory compaction: {completed} completed · {incomplete} incomplete · {failed} failed", "最近20次已结束请求。\n压缩完成：{completed}次\n压缩未完成：{incomplete}次\n压缩失败：{failed}次"],
    "Recent upstream request metadata, not exact live session occupancy. Missing values are unknown. No prompt or image content is retained.": ["Size: MiB. Usage and capacity: Token.\nRequest records, not exact current thread usage.\nMissing data is unknown. No prompts or images are saved.", "大小单位：MiB。\n用量单位：Token。\n不是会话当前的精确占用。\n缺失数据表示未知。\n不保存提问或图片内容。"],
    "Runtime details": ["Runtime details", "运行详情"],
    "ADAPTER": ["SERVICE", "服务状态"],
    "KNOWN MODELS": ["MODEL COUNT", "模型数量"],
    "REQUESTS": ["REQUESTS", "请求次数"],
    "Per-request limits (active)": ["Per-request limits", "单次上限"],
    "MODEL OUTCOMES": ["REQUEST RESULTS", "处理结果"],
    "Completed": ["Completed", "已完成"],
    "Incomplete": ["Incomplete", "未完成"],
    "Failed": ["Failed", "失败"],
    "Cancelled": ["Cancelled", "已取消"],
    "HTTP 2xx != model completed.": ["HTTP 2xx can still mean an unfinished reply.", "HTTP 2xx也可能没答完整。"],
    "LOCAL HISTORY": ["LOCAL HISTORY", "对话暂存"],
    "ACTIVE LIMIT": ["STORAGE LIMIT", "存储上限"],
    "History cache usage": ["Local history usage", "对话暂存"],
    "IMAGE GENERATION": ["IMAGE GENERATION", "图片生成"],
    "OPTIONAL": ["OPT-IN", "按需开启"],
    "Live upstream models": ["Online models", "在线模型"],
    "UPSTREAM GPT MODELS": ["ONLINE MODELS", "在线模型"],
    "CHECKING LIVE": ["CHECKING", "查询中"],
    "Querying GitHub Copilot…": ["Checking Copilot models…", "正在查询Copilot模型。"],
    "MODEL": ["MODEL", "模型"],
    "VENDOR": ["PROVIDER", "提供方"],
    "API": ["INTERFACE", "连接方式"],
    "FLAG": ["STAGE", "阶段"],
    "Loading…": ["Loading…", "加载中"],
    "Catalog listing does not guarantee inference access.": ["A listed model may still be unavailable to your account.", "模型列出后，仍可能无法使用。"],
    "Usage by model": ["Model usage", "模型用量"],
    "USAGE": ["MODEL USAGE", "模型用量"],
    "READING LOG": ["COUNTING", "统计中"],
    "All history": ["Show all", "查看全部"],
    "Aggregating local usage metadata…": ["Counting local usage…", "正在统计本机用量。"],
    "CALLS": ["REQUESTS", "请求次数"],
    "INPUT": ["INPUT USAGE", "输入用量"],
    "CACHE READ": ["REUSED INPUT", "重用输入"],
    "OUTPUT": ["OUTPUT USAGE", "输出用量"],
    "TOTAL": ["TOTAL", "总用量"],
    "CACHE HIT": ["REUSE RATE", "重用比例"],
    "Cache hit = recorded cached / input tokens. ~ = incomplete history. — = unavailable or invalid counts.": ["Usage unit: Token. Reuse rate = reused input / input usage.\n~ means incomplete records. — means unknown or invalid data.", "用量单位：Token。\n重用输入占输入用量的比例。\n~：记录不完整。\n—：数据未知或无效。"],
    "USAGE ANALYTICS": ["USAGE TRENDS", "用量趋势"],
    "Model": ["Model", "模型"],
    "All models": ["All models", "全部模型"],
    "Daily range": ["Date range", "时间范围"],
    "7 days": ["Last 7 days", "近7天"],
    "30 days": ["Last 30 days", "近30天"],
    "90 days": ["Last 90 days", "近90天"],
    "Activity": ["Measure", "统计内容"],
    "Calls": ["Requests", "请求次数"],
    "Tokens": ["Usage (Token)", "处理用量"],
    "Open to read retained usage history.": ["Open to view usage trends.", "展开查看用量趋势。"],
    "DAILY TOKENS": ["DAILY USAGE", "每日用量"],
    "INPUT + OUTPUT / CACHE INCLUDED IN INPUT": ["INPUT + OUTPUT · REUSED INPUT INCLUDED", "输入与输出合计。\n重用部分已计入输入用量。"],
    "Daily token usage": ["Daily usage in Token", "每日用量"],
    "Input": ["Input usage", "输入用量"],
    "Output": ["Output usage", "输出用量"],
    "REQUEST ACTIVITY · 365 DAYS": ["ACTIVITY · LAST 365 DAYS", "活跃日历"],
    "Daily recorded request activity": ["Daily recorded activity over 365 days", "每日活跃"],
    "Select a day to inspect its model totals. No history is distinct from zero recorded calls.": ["Select a day to view its usage.\nNo records is different from zero requests.", "点击日期，查看当天用量。\n没有记录，不等于零次请求。"],
    "Recent failures": ["Recent issues", "异常记录"],
    "RECENT RESPONSE FAILURES": ["RECENT ISSUES", "异常记录"],
    "Reading…": ["Reading…", "读取中"],
    "Reading status…": ["Reading status…", "读取中"],
    "Upstream messages may contain sensitive text.": ["Error details may contain private information.", "错误内容可能含私人信息。"],
    "TERMINAL ANIMATION": ["TERMINAL ANIMATION", "终端动效"],
    "Animation theme": ["Animation style", "动效样式"],
    "Save selection": ["Save animation", "保存动效"],
    "Applies on next ccdx start.": ["Save, then restart ccdx to apply.", "保存后，下次启动生效。"],
    "LOCAL ONLY / NO BACKGROUND POLLING": ["LOCAL ONLY · NO TIMED REFRESH", "仅在本机查看。不会定时读取。"],
    "Saved GitHub Copilot account / local credentials only; not an online entitlement check.": ["Saved local sign-in details only.\nOnline access has not been checked.", "仅查看本机保存的登录信息。\n尚未核实在线使用权限。"],
    "GitHub / READING": ["GitHub / READING", "GitHub / 读取中"],
    "GitHub / UNAVAILABLE": ["GitHub / UNAVAILABLE", "GitHub / 无法读取"],
    "GitHub / NOT CONFIGURED": ["GitHub / NOT SET UP", "GitHub / 未设置"],
    "GitHub / INVALID": ["GitHub / INVALID DETAILS", "GitHub / 信息无效"],
    "GitHub / {account} / SAVED": ["GitHub / {account} / SAVED", "GitHub / {account} / 已保存"],
    "account unknown": ["account unknown", "账号未知"],
    "pid {pid} / uptime {duration}": ["PID {pid} · running {duration}", "进程编号：{pid} · 已运行：{duration}"],
    "BOUND": ["IDENTIFIED", "已识别"],
    "UNCONFIRMED": ["UNCONFIRMED", "待确认"],
    "service token / TTL {duration}": ["Access details expire in {duration}", "有效期：{duration}"],
    "service token not cached": ["No saved access details yet.", "还没有暂存授权信息。"],
    "source {source} / live: ccdx models": ["Source: {source}\nOnline list: ccdx models", "来源：{source}\n在线目录：ccdx models"],
    "built-in": ["built-in list", "内置目录"],
    "cache": ["existing list", "已有目录"],
    "live": ["online list", "在线目录"],
    "unknown": ["unknown", "未知"],
    "4xx {client} / 5xx {server} / active {active}": ["4xx {client} · 5xx {server} · active {active}", "4xx {client} · 5xx {server} · 进行中 {active}"],
    "raw {raw} / decoded {decoded}": ["Received: {raw}\nUnpacked: {decoded}", "接收上限：{raw}\n展开上限：{decoded}"],
    "entries {entries} / trees {trees} / misses {misses} (evicted {evicted})": ["Records: {entries} · groups: {trees}\nNot found: {misses} · after removal: {evicted}", "记录：{entries}条 · 历史分组：{trees}组\n未找到：{misses}次\n清出后未找到：{evicted}次"],
    "{count} succeeded": ["{count} succeeded", "成功：{count}次"],
    "NOT INITIALIZED": ["UNCONFIRMED", "尚未确认"],
    "active {active} / failed {failed} / delivery failures {delivery}": ["Active: {active} · failed: {failed}\nDelivery failures: {delivery}", "进行中：{active} · 生成失败：{failed}\n交付失败：{delivery}"],
    "Setup state unknown / ccdx image-status": ["Check setup:\nccdx image-status", "查看设置：\nccdx image-status"],
    "Snapshot {time}": ["Status updated {time}", "状态更新：{time}"],
    "Status unavailable / check ccdx, then refresh": ["Cannot read status. Check ccdx, then refresh.", "状态读取失败，请检查后刷新。"],
    "{count} retained / requests + events": ["{count} records retained", "保留：{count}条"],
    "No recent request failures recorded.": ["No recent issues recorded.", "暂未记录异常。"],
    "Request ended without successful completion.": ["This request did not finish successfully.", "该请求未能完整完成。"],
    "{detail} / {retry}": ["{detail} / {retry}", "{detail} / {retry}"],
    "retry attempted": ["retried", "已重试"],
    "no retry": ["not retried", "未重试"],
    "time": ["Time", "时间"],
    "model": ["Model", "模型"],
    "event": ["Event type", "事件类型"],
    "code": ["Error code", "错误代码"],
    "message": ["Error details", "错误详情"],
    "response_id": ["Response ID", "回答编号"],
    "upstream_request_id": ["Provider request ID", "服务编号"],
    "request_id": ["Local request ID", "本机编号"],
    "outcome": ["Result", "处理结果"],
    "origin": ["Reported by", "结果来源"],
    "phase": ["Last step", "最后步骤"],
    "http_status": ["HTTP status", "返回状态"],
    "upstream_attempts": ["Send attempts", "发送次数"],
    "timings_ms": ["Timeline (ms)", "时间记录（毫秒）"],
    "retry": ["Retry status", "重试情况"],
    "retry_policy": ["Retry rule", "重试规则"],
    "retry_skipped": ["Skip reason", "跳过原因"],
    "attempted (outcome not recorded here)": ["Retried; result not recorded here.", "已重试；这里未记录结果。"],
    "attempted": ["retried", "已重试"],
    "not attempted": ["not retried", "未重试"],
    "Copy diagnostic": ["Copy details", "复制详情"],
    "Copied": ["Copied", "已复制"],
    "Copy unavailable": ["Copy failed", "复制失败"],
    "DEFAULT": ["DEFAULT", "默认"],
    "Disabled by CCDX_TERMINAL_ANIMATION; saved choice applies after override removal and next start.": ["Disabled by CCDX_TERMINAL_ANIMATION.\nRemove this setting, then restart to apply your saved choice.", "启动设置已关闭动效。\nCCDX_TERMINAL_ANIMATION\n移除此设置后，重启生效。"],
    "Saved choice applies on next ccdx start.": ["Saved choice applies after restarting ccdx.", "保存后，下次启动生效。"],
    "CURRENT {theme}{unsaved}": ["SAVED {theme}{unsaved}", "已保存：{theme}{unsaved}"],
    " / UNSAVED": [" / UNSAVED", " / 待保存"],
    "Saving…": ["Saving…", "保存中"],
    "Not saved / {error}": ["Not saved: {error}", "保存失败：{error}"],
    "preview": ["preview", "测试版"],
    "No selectable GPT models advertised.": ["No selectable GPT models found.", "暂未发现可选GPT模型。"],
    "LIVE SNAPSHOT": ["FETCHED", "已获取"],
    "{selectable} selectable / {advertised} advertised / {host} / {time}": ["Selectable: {selectable} · listed: {advertised}\nSource: {host} · checked {time}", "可选：{selectable}个 · 服务列出：{advertised}个\n来源：{host} · 获取时间：{time}"],
    "LIVE LOOKUP FAILED": ["CHECK FAILED", "查询失败"],
    "No live catalog available.": ["Cannot get the model list.", "无法获取模型列表。"],
    "No usage records.": ["No usage records yet.", "暂未记录用量。"],
    "LOCAL LOG": ["LOCAL RECORDS", "本机记录"],
    "{records} records / {shown} of {models} models shown{day}": ["Records: {records} · models: {shown} of {models}{day}", "记录：{records}条\n模型：展示{shown}个，共{models}个{day}"],
    " / {zone} / {model}": [" / {zone} / {model}", " / {zone} / {model}"],
    "no retained history": ["no records", "没有记录"],
    "{calls} recorded calls / input {input} / output {output} / cached {cached} (included in input){partial}": ["{calls} recorded requests\nInput: {input} · output: {output} · reused: {cached} Token\nReused input is included in input usage.{partial}", "请求：{calls}次\n输入用量：{input} Token\n输出用量：{output} Token\n重用输入：{cached} Token\n重用部分已计入输入用量。{partial}"],
    " / partial token counts": ["\nIncomplete usage records.", "\n用量记录不完整。"],
    "{date} / {description}": ["{date} / {description}", "{date} / {description}"],
    "{metric} / PEAK {peak}": ["365 DAYS · {metric} · PEAK {peak}", "近365天 · {metric} · 峰值{peak}"],
    "INPUT + OUTPUT": ["TOTAL USAGE (Token)", "总用量"],
    "RECORDED CALLS": ["RECORDED REQUESTS", "请求次数"],
    "{zone} / {from} — {to} / retained history starts {first}; oldest day may be partial.{excluded}{limit}": ["{zone} · {from} — {to}\nEarliest record: {first}. That day may be incomplete.{excluded}{limit}", "时区：{zone}\n记录范围：{from}—{to}\n最早记录：{first}\n最早一天的记录可能不全。{excluded}{limit}"],
    " {count} records with invalid/future timestamps excluded.": ["\nSkipped {count} records with invalid or future dates.", "\n已跳过{count}条时间异常记录。"],
    " Model filters limited to 100; all-model totals include the remainder.": ["\nFilters show up to 100 models. Totals include the rest.", "\n只列出前100个模型。\n总计包含其余模型。"],
    "Selected {date} / {model}: totals in the Usage table above / All history resets the table.": ["Selected: {date} / {model}. See the usage table above.\nChoose Show all to reset the date.", "已选：{date}／{model}\n当天用量见上方表格。\n点击“查看全部”恢复总表。"],
    "Select a day for model totals. Calls are usage records, not messages or time. Hatched cells: no retained history; empty cells: zero recorded calls.": ["Select a day to view its usage.\nCounts are recorded requests, not messages or time.\nHatched: no records. Blank: zero recorded requests.", "点击日期，查看当天用量。\n按已记录的请求统计。\n不代表消息数或使用时长。\n斜线格表示没有记录。\n空白格表示已记录零次请求。"],
    "LOG UNAVAILABLE": ["READ FAILED", "读取失败"],
    "No usage summary available.": ["Cannot read usage records.", "无法读取用量记录。"],
    "Analytics unavailable / refresh Usage to retry.": ["Trends unavailable. Refresh Model usage to retry.", "统计失败，请刷新用量。"],
    "Animation settings are invalid; inspect them with ccdx animation": ["Invalid animation settings.\nRun ccdx animation.", "设置无效，请检查动效。\n运行ccdx animation。"],
    "Animation setting was not saved; check ccdx animation": ["Animation was not saved.\nRun ccdx animation.", "保存失败，请检查动效。\n运行ccdx animation。"],
    "Could not read local usage summary": ["Cannot read usage. Refresh to retry.", "无法读取用量，请刷新。"],
    "Live model lookup timed out. Retry or run ccdx models.": ["Model check timed out. Try again.\nRun ccdx models for details.", "模型查询超时，请重试。\n运行ccdx models。"],
    "GitHub token not found. Start ccdx to sign in.": ["No GitHub sign-in details found.\nRun ccdx to sign in.", "未找到登录信息。\n运行ccdx登录。"],
    "Live model lookup failed. Run ccdx models for details.": ["Model check failed.\nRun ccdx models for details.", "模型查询失败，请查看详情。\n运行ccdx models。"],
    "Live model lookup failed (HTTP {status}). Run ccdx models for details.": ["Model check failed: HTTP {status}.\nRun ccdx models for details.", "模型查询失败：HTTP {status}\n运行ccdx models。"],
    "Select a listed animation theme": ["Choose an animation from the list.", "请选择列表中的动效。"],
    "Animation changes require the same-origin dashboard": ["Save from this computer's dashboard.", "请从本机看板保存动效。"],
    "Animation changes require application/json": ["The save format is invalid.", "保存内容格式不正确。"],
    "Invalid animation request body": ["The animation selection is invalid.", "动效选择格式不正确。"],
    "Select a valid usage time zone": ["Choose a valid time zone.", "所选时区无效。"],
    "Method not allowed": ["This action is not supported.", "此操作不受支持。"],
    "Dashboard API is available only at a loopback address": ["Open the dashboard on this computer.", "请在本机打开看板。"],
    "Dashboard API requires a same-origin page request": ["Use this computer's dashboard to continue.", "请从本机看板操作。"],
    "{time} / {model} / {code}": ["{time} / {model} / {code}", "{time} / {model} / {code}"],
    "unknown time": ["unknown time", "时间未知"],
    "unknown_model": ["unknown model", "模型未知"],
    "unknown_error": ["unknown error", "错误未知"],
    "{index} {theme}": ["{index} {theme}", "{index} {theme}"],
    "Comet": ["Comet", "彗星"],
    "Twin": ["Twin", "双星"],
    "Shuttle": ["Shuttle", "往返"],
    "Chase": ["Chase", "追逐"],
    "Mirror": ["Mirror", "对称"],
    "Pulse": ["Pulse", "呼吸"],
    "Stack": ["Stack", "堆叠"],
    "Relay": ["Relay", "接力"],
    "Split": ["Split", "分岔"],
    "COMET": ["COMET", "彗星"],
    "TWIN": ["TWIN", "双星"],
    "SHUTTLE": ["SHUTTLE", "往返"],
    "CHASE": ["CHASE", "追逐"],
    "MIRROR": ["MIRROR", "对称"],
    "PULSE": ["PULSE", "呼吸"],
    "STACK": ["STACK", "堆叠"],
    "RELAY": ["RELAY", "接力"],
    "SPLIT": ["SPLIT", "分岔"],
  };
  const storageKey = "ccdx.dashboard.language";
  let language = "en";
  try { if (localStorage.getItem(storageKey) === "zh") language = "zh"; } catch {}
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  const messages = new WeakMap();
  const attributes = { textContent: "data-i18n", title: "data-i18n-title", "aria-label": "data-i18n-label" };

  function format(key, values = {}) {
    const template = Object.hasOwn(translations, key) ? translations[key][language === "zh" ? 1 : 0] : key;
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
    const label = language === "en" ? "Switch to Chinese" : "切换英文";
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
