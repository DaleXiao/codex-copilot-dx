# CCDX 1.4.9

## English

- Small Antigravity control requests, including model and account lookups, no longer wait behind large uploads in other apps.
- Antigravity Copilot request details distinguish body writes, send completion, and connection errors. A response without a stream body reports an error instead of opening a successful stream. The request log identifies Antigravity timeouts and counts them under generation.
- Codex Chat fallback skips redundant empty user placeholders from compacted history. Text, images, and supported cache markers are preserved.

Not verified: Carbon timeout recovery against live Copilot.

## 简体中文

- Antigravity 的模型、账户等小型查询不再被其他应用的大请求上传挡住。
- Antigravity 的 Copilot 请求详情会区分已提交的正文、发送完成和连接错误。来源没有返回流正文时，直接报告错误。请求记录会标明 Antigravity 超时，并把它归入生成失败。
- Codex 经 Chat 接口转发时，跳过压缩历史中多余的空白用户占位，保留文本、图片和受支持的缓存标记。

未验证：真实 Copilot 上的 Carbon 超时是否恢复。
