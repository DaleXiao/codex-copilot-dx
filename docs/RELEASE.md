# CCDX 1.4.7

## English

- Uploads of unknown length reserve request-body memory as data arrives. Small uploads can proceed alongside existing requests; reads pause if more space is needed.
- Bodyless Antigravity control requests skip the body queue. Request details show why a request waited and whether it was admitted.
- Configure the shared body budget under **Settings → Advanced: request limits**. Changes apply at the next start.

Not verified: live provider timeouts, native app adoption, or sustained production load.

## 简体中文

- 长度未知的上传按收到的字节逐步预留请求体内存。短上传无需等整池清空；额度不够时暂停读入。
- 无正文的 Antigravity 控制请求不再进入正文队列。请求详情显示入队原因和排队结果。
- 在「设置 → 高级：请求限制」调整共享请求体内存额度，下次启动生效。

未验证：真实来源超时、原生应用接入和长时间线上负载。
