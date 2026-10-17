# 界面文案规则与交付对照

CLI 保持英文；WebUI 保留中英双语。中文功能名以 2–4 字为主，固定描述每行不超过 20 字；必要信息可以分条。产品名、模型名、命令、错误码、占位符与单位保留。缩短说明不能改变业务事实。

- [CLI 原文案 → 新文案](CLI_COPY.md)：529 项静态候选与动态状态补充。
- [WebUI 原文案 → 新文案](WEBUI_COPY.md)：399 个固定消息。

WebUI 使用固定消息标识，显示文字可以独立调整。旧消息别名只用于已有状态名和服务端诊断的兼容。未知上游文案保留原文；不根据措辞猜测权限、过期或成功。代码测试核对双语占位符、短中文、状态事实与切换后数据保持。

| 原文案或歧义 | 最终呈现 | 事实边界 |
| --- | --- | --- |
| Clear inactive buffer | Clear conversation buffer / 清空暂存 | 清空所有对话暂存；拒绝活动用户；保存的 Codex 记录保留 |
| SERVICE REACHABLE | CONNECTED LOCALLY / 已连本机 | 只证明本机入口可读 |
| Provider / vendor 混用 | Model source / 模型来源；Model maker / 模型厂商 | 服务来源与模型厂商分别命名 |
| Prediction | Input suggestions / 输入建议 | 已开启不证明建议已显示 |
| Cache read | Reused input / 复用输入 | 已计入输入用量；不承诺费用减免 |
| Saved On / effective On / next start | Saved On / next start | 下次启动生效，不能声称当前已生效 |
| 客户端恢复后回退成未知 | Settings restored / 已恢复设置 | 恢复、用户配置保留、未检查分别呈现 |

默认摘要保持简短；详细帮助、安全说明、原始状态码与诊断证据保留。来源选择始终由用户明确应用，浏览目录不会切换服务。
