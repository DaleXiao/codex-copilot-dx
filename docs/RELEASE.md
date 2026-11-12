# CCDX 1.3.23

- 改善 GitHub Copilot Gemini 4 Carbon 在 Codex 中的工具调用和网页搜索。
- 新增 macOS Gemini 原 App 的 Antigravity 接入，可选择 Copilot Carbon 和 Argon，并在 Web UI 与终端中管理。
- Gemini 普通聊天保留 Google。启用接入后，Antigravity 的摘要、搜索和图像生成统一走 Copilot；主回答按所选 Google 或 Copilot 模型路由。此功能默认关闭，不修改 Gemini 安装包或 Google 凭据。
- 改善网页启动，避免部分脚本未加载时出现连锁初始化错误。

未验证：原 App 的真实搜索与图像生成、其他 Gemini App 版本、局部热请求及续接耗时的严格零退化；Copilot 的 PDF、音频、视频附件暂不支持。
