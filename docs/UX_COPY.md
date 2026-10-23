# 界面文案规则与交付对照

CLI 保持英文；WebUI 保留中英双语。名称和说明按表达需要决定长短，不设硬性字数；必要信息可以分条。产品名、模型名、命令、错误码、占位符与单位保留。缩短说明不能改变业务事实。

- [CLI 原文案 → 新文案](CLI_COPY.md)：529 项静态候选与动态状态补充。
- [WebUI 原文案 → 新文案](WEBUI_COPY.md)：固定消息与后续版本补充。

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

## 1.2.2 appearance and check feedback

| English | Chinese | Scope |
| --- | --- | --- |
| Web appearance | 网页外观 | Browser-local color |
| Terminal appearance | 终端外观 | Local console color and existing motion |
| Color theme | 颜色主题 | Classic green / Klein blue |
| This tab only. Browser storage is unavailable. | 本次有效，浏览器未能保存。 | Failed browser persistence |
| Table updated. Startup logo changes next launch. | 表格已换色，启动 Logo 下次生效。 | Successful live color save |
| Check details | 检查详情 | Bounded model-list failure evidence |

Names follow meaning rather than a fixed character limit. CLI remains English and WebUI bilingual.

## 1.2.10 clarification

| Previous | Current | 中文 |
| --- | --- | --- |
| Source / entire page | Source | 来源 |
| Check GitHub connection (navigation) | Open GitHub checks | 前往 GitHub 检查 |
| Saved in this browser. Changes apply now. | This browser only. Applies now. | 仅此浏览器，立即生效。 |
| Saved: On / Active: On / Active now | On · Active now | 开启 · 立即生效 |
| Unavailable / m365_catalog_http_403 | Fixed catalog cause with HTTP/check evidence | 目录拒绝原因及检查详情 |

Saved/effective mismatches, startup overrides, installation policy and destructive
action consequences retain their specific explanations. CLI stays English;
WebUI keeps both languages. Selection marks are removed from buttons only; the
existing circle status SVGs remain.

## 1.2.13 API and client access

| English | Chinese | Fact boundary |
| --- | --- | --- |
| Add API | 添加 API | Saves metadata/key; no automatic inference or client switch |
| Allowed clients / Allowed sources | 允许使用的客户端 / 允许使用的来源 | Permission is separate from current selection |
| Current source | 当前来源 | Exactly one chosen source, or paused access |
| Configured models | 已配置的模型 | Saved declarations; not verified online entitlement |
| Disable source / Pause access | 关闭来源 / 暂停接入 | New calls stop; existing API requests retain their source |
| Disabled / Enable again | 已关闭 / 重新开启 | Configuration/grants remain; recovery does not choose a route |
| CCDX access is off; the app stays open. | 接入已关闭，应用保持运行。 | Never quits the user's app |
| Stored separately. Never sent to clients. | 独立保存，不会传给客户端。 | Upstream key is protected; clients receive local credentials |

Only Messages/Responses-native clients are connected in this release. Header
choices, environment references and model-interface declarations stay in their
relevant forms. Key, URL, protocol, state-file, conflict and history errors retain
necessary codes and bilingual explanations. First setup/reopen, user-preserved
configuration and successful inference remain separate facts. CLI stays English.

## 1.2.14 model selection

| Previous | Current | 中文 |
| --- | --- | --- |
| Add model (always-visible ID field) | Add a model manually (collapsed, optional) | 手工添加模型 |
| Choose the APIs each model supports. | Select the models to use and their supported APIs. | 勾选要使用的模型，再选择其支持的接口。 |
| Generic model validation error after a partial selection | Choose an API for {model}, or deselect it. | 请为 {model} 选择接口，或取消勾选该模型。 |

Catalog reads do not select every returned model. Protocol selection selects its
model; unselected rows are omitted from the save. A client can choose the source
after compatible models are saved. Manual ID entry remains optional.
