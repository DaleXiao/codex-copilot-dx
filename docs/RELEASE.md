# CCDX 1.4.3

- Antigravity 从 GitHub Copilot 目录动态列出兼容的 Gemini 模型，不再只列出 Carbon、Argon；Hydrogen 及其 xhigh 档位可随目录出现。
- 页面刷新与 `ccdx app antigravity models --refresh` 会更新上游目录，保留已保存选择和未保存草稿；刷新失败保留原列表。
- 保留原生 Google 模型和现有路由，已有 Carbon、Argon 模型别名继续有效。
- 模型目录明确不支持图片时，Codex 不再沿用原生模板的图片能力；能力未知时保留原有处理。

未验证：真实上游模型生成、原生客户端完整目录接纳及长期负载。
