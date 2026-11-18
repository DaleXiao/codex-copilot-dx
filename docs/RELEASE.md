# CCDX 1.4.9

## English

- Small Antigravity control requests, including model and account lookups, no longer wait behind large uploads in other apps.
- Antigravity Copilot request details show when CCDX finished sending the body. A response without a stream body reports an error instead of opening a successful stream.
- Codex Chat fallback skips redundant empty user placeholders from compacted history. Text, images, and supported cache markers are preserved.

Not verified: Carbon timeout recovery against live Copilot.

## 简体中文

- Antigravity 的模型、账户等小型查询不再被其他应用的大请求上传挡住。
- Antigravity 的 Copilot 请求详情会显示 CCDX 何时发完正文。来源没有返回流正文时，直接报告错误。
- Codex 经 Chat 接口转发时，跳过压缩历史中多余的空白用户占位，保留文本、图片和受支持的缓存标记。

未验证：真实 Copilot 上的 Carbon 超时是否恢复。
