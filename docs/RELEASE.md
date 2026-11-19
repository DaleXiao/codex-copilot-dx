# CCDX 1.4.9

## English

- Antigravity shows when saved model settings need a reopen. A default is for new conversations; existing conversations keep their selected models.
- Small Antigravity control requests, including model and account lookups, no longer wait behind large uploads in other apps.
- Antigravity Copilot request details distinguish body writes, send completion, and connection errors. A response without a stream body reports an error instead of opening a successful stream. The request log shows total time, identifies Antigravity timeouts, and includes the outbound request ID in copied details. Valid upstream retry guidance is preserved.
- Codex Chat fallback skips redundant empty user placeholders from compacted history. Text, images, and supported cache markers are preserved.

Not verified: Carbon timeout recovery against live Copilot.

## 简体中文

- Antigravity 的模型设置需要重新打开应用时，直接显示对应操作。默认项用于新会话，旧会话保留原选模型。
- Antigravity 的模型、账户等小型查询不再被其他应用的大请求上传挡住。
- Antigravity 的 Copilot 请求详情会区分已提交的正文、发送完成和连接错误。来源没有返回流正文时，直接报告错误。请求记录突出总耗时，区分超时阶段，并在复制详情时保留出站编号。来源提供的有效重试提示也会保留。
- Codex 经 Chat 接口转发时，跳过压缩历史中多余的空白用户占位，保留文本、图片和受支持的缓存标记。

未验证：真实 Copilot 上的 Carbon 超时是否恢复。
