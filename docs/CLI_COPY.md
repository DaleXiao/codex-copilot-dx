# CLI 文案对照

此表保留历史文案对照，不作为当前功能说明。当前行为以 README 和 REFERENCE 为准；1.2.3 公司账号增量见文末。
基线：1.1.1；现文案：1.2.0。CLI 保持英文。以下 529 项是此前讨论的静态候选，包括帮助、提示和诊断片段；不是对所有动态错误内容的枚举。位置为基线文件与行号。帮助改为分条，保留限制、退出行为、命令与参数。未实施的建议列为原样保留。

| 编号 | 基线位置 | 原文案 → 新文案 |
| --- | --- | --- |
| CLI-001 | bin/cli.mjs:39 | Run ${CLI_NAME} --help for usage. → Help: ${CLI_NAME} --help |
| CLI-002 | bin/cli.mjs:91 | The CCDX prediction panel has been retired and cannot be enabled. → The old suggestion panel is no longer supported. |
| CLI-003 | bin/cli.mjs:92 | Legacy settings remain; run ${CLI_NAME} suggestion off to clean them up. → Legacy settings remain; run ${CLI_NAME} suggestion off to clean them up. |
| CLI-004 | bin/cli.mjs:93 | Modified prediction settings were preserved. → Your edited suggestion settings were kept. |
| CLI-005 | bin/cli.mjs:169 | ${CLI.integration} integration was retired in ccdx 0.7.0. → ${CLI.integration} integration was retired in ccdx 0.7.0. |
| CLI-006 | bin/cli.mjs:171 | Update or reinstall PM Studio to remove an older CCDX app patch. → Update or reinstall PM Studio to remove an older CCDX app patch. |
| CLI-007 | bin/cli.mjs:173 | Remove any old CCDX endpoint from the client before using a different provider. → Remove any old CCDX endpoint from the client before using a different provider. |
| CLI-008 | bin/cli.mjs:295 | WebUI → Dashboard |
| CLI-009 | bin/cli.mjs:295 | Browser unavailable; open ${webUiUrl} → Could not open browser. Open ${webUiUrl} |
| CLI-010 | bin/cli.mjs:296 | WebUI → Dashboard |
| CLI-011 | bin/cli.mjs:304 | Client → App |
| CLI-012 | bin/cli.mjs:310 | Debug log: ${LOGGING.filePath} → Details log: ${LOGGING.filePath} |
| CLI-013 | bin/cli.mjs:311 | Debug logging enabled → Detailed logging on |
| CLI-014 | bin/cli.mjs:322 | Adapter ${found} is already running at ${running.baseUrl}, but this CLI is ${LOCAL_VERSION}. Stop the existing process and run ${CLI_NAME} again. → Adapter ${found} is already running at ${running.baseUrl}, but this CLI is ${LOCAL_VERSION}. Stop the existing process and run ${CLI_NAME} again. |
| CLI-015 | bin/cli.mjs:327 | Adapter → Service |
| CLI-016 | bin/cli.mjs:327 | Using existing service at ${running.baseUrl} → Using running service: ${running.baseUrl} |
| CLI-017 | bin/cli.mjs:328 | Auth → Sign-in |
| CLI-018 | bin/cli.mjs:328 | Using existing service credentials; not rechecked → Using saved sign-in; not rechecked |
| CLI-019 | bin/cli.mjs:348 | Restart ccdx to activate the newly enabled prediction bridge → Restart ccdx to activate the newly enabled prediction bridge |
| CLI-020 | bin/cli.mjs:354 | Images → Images |
| CLI-021 | bin/cli.mjs:355 | Client setup skipped; see warning above → App setup skipped; see warning |
| CLI-022 | bin/cli.mjs:355 | Configured; provider not tested → Configured; not tested |
| CLI-023 | bin/cli.mjs:355 | Off → Off |
| CLI-024 | bin/cli.mjs:387 | Update available: ${LOCAL_VERSION} -&gt; ${latestVersion}. Run ${CLI_NAME} update github to update, then restart ${CLI_NAME}. → Update available: ${LOCAL_VERSION} -&gt; ${latestVersion}. Run ${CLI_NAME} update github to update, then restart ${CLI_NAME}. |
| CLI-025 | bin/cli.mjs:399 | Command → Command |
| CLI-026 | bin/cli.mjs:399 | Windows command entry updated; use ccdx next time → Windows command ready; use ccdx |
| CLI-027 | bin/cli.mjs:400 | Command → Command |
| CLI-028 | bin/cli.mjs:400 | Existing launcher preserved; use ccdx.cmd doctor to inspect it → Existing launcher preserved; use ccdx.cmd doctor to inspect it |
| CLI-029 | bin/cli.mjs:401 | Command → Command |
| CLI-030 | bin/cli.mjs:401 | Optional command setup skipped; core startup will continue → Command setup skipped; service will start |
| CLI-031 | bin/cli.mjs:424 | Models → Models |
| CLI-032 | bin/cli.mjs:433 | Auth → Sign-in |
| CLI-033 | bin/cli.mjs:433 | GitHub authorization is unavailable; Microsoft 365 is independent. Check ccdx m365 status or switch → GitHub authorization is unavailable; Microsoft 365 is independent. Check ccdx m365 status or switch |
| CLI-034 | bin/cli.mjs:436 | Provider → Source |
| CLI-035 | bin/cli.mjs:436 | Codex uses the explicitly selected Microsoft 365 backup → Codex source: Microsoft 365 |
| CLI-036 | bin/cli.mjs:444 | Models → Models |
| CLI-037 | bin/cli.mjs:444 | ${profileModels.codexRegistry.source} list loaded${profileModels.codexRegistry.refreshInFlight ? "; refreshing" : ""} → ${profileModels.codexRegistry.source} list loaded${profileModels.codexRegistry.refreshInFlight ? "; refreshing" : ""} |
| CLI-038 | bin/cli.mjs:444 | ; refreshing → ; refreshing |
| CLI-039 | bin/cli.mjs:448 | ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks. → ADAPTER_HOST=${ADAPTER_HOST} exposes the adapter beyond loopback because CCDX_ALLOW_LAN=1 is set. Use only on trusted networks. |
| CLI-040 | bin/cli.mjs:489 | Images → Images |
| CLI-041 | bin/cli.mjs:490 | Client setup skipped; see warning above → App setup skipped; see warning |
| CLI-042 | bin/cli.mjs:490 | Configured; provider not tested → Configured; not tested |
| CLI-043 | bin/cli.mjs:490 | Off → Off |
| CLI-044 | bin/cli.mjs:513 | Shutting down on ${signal}... → Stopping: ${signal} |
| CLI-045 | bin/cli.mjs:520 | Forced remaining adapter connections closed → Remaining service connections closed |
| CLI-046 | bin/cli.mjs:524 | Shutdown failed: ${e.message} → Could not stop: ${e.message} |
| CLI-047 | src/auth-credentials.mjs:27 | ${reason}<br>Delete the saved GitHub token, then run ccdx again to log in:<br>  rm '${tokenPath}'<br>  ccdx → ${reason}<br>Delete the saved GitHub token, then run ccdx again to log in:<br>  rm '${tokenPath}'<br>  ccdx |
| CLI-048 | src/auth-credentials.mjs:164 | unknown source → unknown source |
| CLI-049 | src/auth-credentials.mjs:167 | local auth file (${source.path}) → local auth file (${source.path}) |
| CLI-050 | src/auth-credentials.mjs:168 | OpenCode Copilot auth (${source.path}) → OpenCode Copilot auth (${source.path}) |
| CLI-051 | src/auth-credentials.mjs:169 | GitHub CLI (github.com) → GitHub CLI (github.com) |
| CLI-052 | src/auth-device-flow.mjs:21 | The operation was aborted → Cancelled |
| CLI-053 | src/auth-device-flow.mjs:81 | Device code request timed out after ${timeoutMs}ms → Device code request timed out after ${timeoutMs}ms |
| CLI-054 | src/auth-status.mjs:16 | The operation was aborted → Cancelled |
| CLI-055 | src/auth-status.mjs:23 | Copilot model catalog contained no model list → Copilot model catalog contained no model list |
| CLI-056 | src/auth-status.mjs:41 | Copilot model catalog timed out after ${deadlineMs}ms → Copilot model catalog timed out after ${deadlineMs}ms |
| CLI-057 | src/auth-status.mjs:57 | Copilot model catalog → Copilot model catalog |
| CLI-058 | src/auth-status.mjs:62 | Copilot model catalog failed with HTTP ${response.status}${detail ? `: ${detail}` : ""} → Copilot model catalog failed with HTTP ${response.status}${detail ? `: ${detail}` : ""} |
| CLI-059 | src/auth-status.mjs:69 | Copilot model catalog returned invalid JSON → Copilot model catalog returned invalid JSON |
| CLI-060 | src/auth-status.mjs:123 | timed out after ${timeoutMs}ms → timed out after ${timeoutMs}ms |
| CLI-061 | src/auto-review-model.mjs:79 | No selectable Responses models are available (${liveError}). Start ccdx once to refresh the model list. → No selectable Responses models are available (${liveError}). Start ccdx once to refresh the model list. |
| CLI-062 | src/auto-review-model.mjs:95 | ${commandName} auto-review-model requires an interactive terminal → ${commandName} auto-review-model requires an interactive terminal |
| CLI-063 | src/auto-review-model.mjs:102 | No selectable Responses models are available → No selectable Responses models are available |
| CLI-064 | src/auto-review-model.mjs:104 | ${commandName} auto-review-model<br> → ${commandName} auto-review-model<br> |
| CLI-065 | src/auto-review-model.mjs:105 | Current: ${current.model} (${current.source})<br> → Current: ${current.model} (${current.source})<br> |
| CLI-066 | src/auto-review-model.mjs:106 | Reasoning: ${current.reasoningEffort &#124;&#124; "follow client (low when omitted)"}<br> → Reasoning: ${current.reasoningEffort &#124;&#124; "follow client (low when omitted)"}<br> |
| CLI-067 | src/auto-review-model.mjs:106 | follow client (low when omitted) → follow client (low when omitted) |
| CLI-068 | src/auto-review-model.mjs:107 | Responses models from ${catalog.source}:<br> → Responses models from ${catalog.source}:<br> |
| CLI-069 | src/auto-review-model.mjs:129 | Select a model [${defaultIndex + 1}], or q to cancel:  → Choose a model [${defaultIndex + 1}], or q to cancel:  |
| CLI-070 | src/auto-review-model.mjs:131 | No changes made.<br> → No changes made.<br> |
| CLI-071 | src/auto-review-model.mjs:138 | Enter a number from 1 to ${modelIds.length}, or q to cancel.<br> → Enter a number from 1 to ${modelIds.length}, or q to cancel.<br> |
| CLI-072 | src/auto-review-model.mjs:146 | Reasoning for ${selectedModel}:<br> → Reasoning for ${selectedModel}:<br> |
| CLI-073 | src/auto-review-model.mjs:147 |   0. Follow client (low when omitted)<br> →   0. Follow client (low when omitted)<br> |
| CLI-074 | src/auto-review-model.mjs:154 | No reasoning efforts are advertised; no override will be set.<br> → No reasoning efforts are advertised; no override will be set.<br> |
| CLI-075 | src/auto-review-model.mjs:156 | Select reasoning [${effortIndex}], or q to cancel:  → Choose thinking level [${effortIndex}], or q to cancel:  |
| CLI-076 | src/auto-review-model.mjs:158 | No changes made.<br> → No changes made.<br> |
| CLI-077 | src/auto-review-model.mjs:165 | Enter a number from 0 to ${efforts.length}, or q to cancel.<br> → Enter a number from 0 to ${efforts.length}, or q to cancel.<br> |
| CLI-078 | src/auto-review-model.mjs:173 | ${result.changed ? "Saved" : "Kept"} Auto Review model: ${selectedModel}<br> → ${result.changed ? "Saved" : "Kept"} Auto Review model: ${selectedModel}<br> |
| CLI-079 | src/auto-review-model.mjs:173 | Saved → Saved |
| CLI-080 | src/auto-review-model.mjs:173 | Kept → Kept |
| CLI-081 | src/auto-review-model.mjs:174 | Reasoning: ${selectedEffort &#124;&#124; "follow client (low when omitted)"}<br> → Reasoning: ${selectedEffort &#124;&#124; "follow client (low when omitted)"}<br> |
| CLI-082 | src/auto-review-model.mjs:174 | follow client (low when omitted) → follow client (low when omitted) |
| CLI-083 | src/auto-review-model.mjs:176 | CCDX_AUTO_REVIEW_MODEL=${current.model} remains the effective override until it is unset. Reasoning is bound to ${selectedModel}.<br> → CCDX_AUTO_REVIEW_MODEL=${current.model} remains the effective override until it is unset. Reasoning is bound to ${selectedModel}.<br> |
| CLI-084 | src/auto-review-model.mjs:178 | The running adapter will use this model on the next Auto Review request. Reasoning selection requires an adapter running 0.9.13 or newer.<br> → The running adapter will use this model on the next Auto Review request. Reasoning selection requires an adapter running 0.9.13 or newer.<br> |
| CLI-085 | src/cli-animation.mjs:41 | ${commandName} animation requires an interactive terminal → ${commandName} animation requires an interactive terminal |
| CLI-086 | src/cli-animation.mjs:48 | ${commandName} animation<br> → ${commandName} animation<br> |
| CLI-087 | src/cli-animation.mjs:49 | Current: ${TERMINAL_ANIMATION_THEMES[currentIndex].label} (${current.source})<br><br> → Current: ${TERMINAL_ANIMATION_THEMES[currentIndex].label} (${current.source})<br><br> |
| CLI-088 | src/cli-animation.mjs:89 | Select [${currentIndex + 1}], or q to cancel:  → Select [${currentIndex + 1}], or q to cancel:  |
| CLI-089 | src/cli-animation.mjs:94 | No changes made.<br> → No changes made.<br> |
| CLI-090 | src/cli-animation.mjs:108 | Enter a number from 1 to ${TERMINAL_ANIMATION_THEMES.length}, or q to cancel.<br> → Enter a number from 1 to ${TERMINAL_ANIMATION_THEMES.length}, or q to cancel.<br> |
| CLI-091 | src/cli-animation.mjs:113 | <br>No changes made.<br> → <br>No changes made.<br> |
| CLI-092 | src/cli-animation.mjs:130 | [WARN] Preview unavailable; the terminal animation setting was still applied.<br> → [WARN] Preview unavailable; the terminal animation setting was still applied.<br> |
| CLI-093 | src/cli-animation.mjs:135 | ${result.changed ? "Saved" : "Kept"} terminal animation: ${selected.label}<br> → ${result.changed ? "Saved" : "Kept"} terminal animation: ${selected.label}<br> |
| CLI-094 | src/cli-animation.mjs:135 | Saved → Saved |
| CLI-095 | src/cli-animation.mjs:135 | Kept → Kept |
| CLI-096 | src/cli-animation.mjs:137 | CCDX_TERMINAL_ANIMATION=${disabledValue} remains effective until it is unset; terminal animation stays disabled.<br> → CCDX_TERMINAL_ANIMATION=${disabledValue} remains effective until it is unset; terminal animation stays disabled.<br> |
| CLI-097 | src/cli-animation.mjs:138 | The saved animation will be used on the next ccdx start after the override is unset.<br> → The saved animation will be used on the next ccdx start after the override is unset.<br> |
| CLI-098 | src/cli-animation.mjs:140 | Running CCDX 1.1.0+ picks up this animation without restart; older services need a restart.<br> → Running CCDX 1.1.0+ picks up this animation without restart; older services need a restart.<br> |
| CLI-099 | src/cli-auth.mjs:13 | not configured → not configured |
| CLI-100 | src/cli-auth.mjs:14 | invalid (${profile.reason}) → invalid (${profile.reason}) |
| CLI-101 | src/cli-auth.mjs:23 | Codex online: ${online.reason &#124;&#124; "unavailable"}${httpStatus} → Codex online: ${online.reason &#124;&#124; "unavailable"}${httpStatus} |
| CLI-102 | src/cli-auth.mjs:26 | Codex online: ${account}${online.models} models → Codex online: ${account}${online.models} models |
| CLI-103 | src/cli-auth.mjs:31 | ${commandName} auth status → ${commandName} auth status |
| CLI-104 | src/cli-auth.mjs:32 | Codex: ${accountLabel(snapshot.profiles.codex)} [legacy path] → Codex: ${accountLabel(snapshot.profiles.codex)} [legacy path] |
| CLI-105 | src/cli-auth.mjs:34 | Routing: responses -&gt; ${snapshot.routing.responses} → Routing: responses -&gt; ${snapshot.routing.responses} |
| CLI-106 | src/cli-auth.mjs:73 | PROFILE → APP |
| CLI-107 | src/cli-auth.mjs:74 | ACCOUNT → ACCOUNT |
| CLI-108 | src/cli-auth.mjs:75 | LOCAL → SAVED SIGN-IN |
| CLI-109 | src/cli-auth.mjs:76 | ONLINE → ACCESS CHECK |
| CLI-110 | src/cli-auth.mjs:77 | MODELS → MODELS |
| CLI-111 | src/cli-auth.mjs:80 | PROFILE → APP |
| CLI-112 | src/cli-auth.mjs:81 | LOCAL → SAVED SIGN-IN |
| CLI-113 | src/cli-auth.mjs:82 | ONLINE → ACCESS CHECK |
| CLI-114 | src/cli-auth.mjs:90 | ${commandName} auth status → ${commandName} auth status |
| CLI-115 | src/cli-auth.mjs:106 | Unsupported auth action: ${action} → Unsupported auth action: ${action} |
| CLI-116 | src/cli-cache.mjs:48 | History cache cleanup cancelled → Buffer cleanup cancelled |
| CLI-117 | src/cli-cache.mjs:52 | History cleanup can break task continuation; rerun with --yes to confirm → Clearing the buffer may prevent chats from continuing.<br>Use --yes to confirm. |
| CLI-118 | src/cli-cache.mjs:57 | Clear response history for all tasks? Their next continuation may fail [y/N]:  → Clear the buffer for all chats? They may not continue [y/N]:  |
| CLI-119 | src/cli-cache.mjs:59 | History cache cleanup cancelled → Buffer cleanup cancelled |
| CLI-120 | src/cli-cache.mjs:64 | ccdx cache → ccdx cache |
| CLI-121 | src/cli-cache.mjs:64 | Configured history limit: ${mib(preference.bytes)} (${preference.source}) → Saved buffer limit: ${mib(preference.bytes)} (${preference.source}) |
| CLI-122 | src/cli-cache.mjs:107 | CCDX_RESPONSE_HISTORY_MAX_BYTES overrides saved cache settings; unset it before using ccdx cache --limit → CCDX_RESPONSE_HISTORY_MAX_BYTES overrides saved cache settings; unset it before using ccdx cache --limit |
| CLI-123 | src/cli-cache.mjs:112 | History currently uses ${mib(runtime.data.response_history.bytes)}; clean history or choose a larger limit → History currently uses ${mib(runtime.data.response_history.bytes)}; clean history or choose a larger limit |
| CLI-124 | src/cli-cache.mjs:127 | History cache limit: ${targetMib} MiB${runtime.supported ? " (active now)" : " (saved; restart ccdx to apply)"}<br> → History cache limit: ${targetMib} MiB${runtime.supported ? " (active now)" : " (saved; restart ccdx to apply)"}<br> |
| CLI-125 | src/cli-cache.mjs:127 |  (active now) →  (active now) |
| CLI-126 | src/cli-cache.mjs:127 |  (saved; restart ccdx to apply) →  (saved; restart ccdx to apply) |
| CLI-127 | src/cli-cache.mjs:131 | Start or restart ccdx before cleaning runtime caches → Start or restart ccdx before cleaning runtime caches |
| CLI-128 | src/cli-cache.mjs:138 | Cleared image transform cache: ${images.entries} entries, ${mib(images.bytes)}<br> → Cleared image transform cache: ${images.entries} entries, ${mib(images.bytes)}<br> |
| CLI-129 | src/cli-cache.mjs:141 | Cleared response history: ${cleared.entries} entries, ${mib(cleared.bytes)}<br> → Cleared response history: ${cleared.entries} entries, ${mib(cleared.bytes)}<br> |
| CLI-130 | src/cli-cache.mjs:142 | Saved Codex transcripts and generated image files were not deleted.<br> → Saved Codex transcripts and generated image files were not deleted.<br> |
| CLI-131 | src/cli-cache.mjs:146 | Unknown cache action: ${action} → Unknown cache action: ${action} |
| CLI-132 | src/cli-image.mjs:28 | Hidden API key input requires an interactive terminal → Hidden API key input requires an interactive terminal |
| CLI-133 | src/cli-image.mjs:46 | Image provider setup cancelled → Image provider setup cancelled |
| CLI-134 | src/cli-image.mjs:69 | Codex configuration is not valid UTF-8 TOML; no configuration changes were written → Codex configuration is not valid UTF-8 TOML; no configuration changes were written |
| CLI-135 | src/cli-image.mjs:82 | Available image models:<br> → Available image models:<br> |
| CLI-136 | src/cli-image.mjs:85 | Select [${currentIndex + 1}]:  → Select [${currentIndex + 1}]:  |
| CLI-137 | src/cli-image.mjs:89 | Enter a number from 1 to ${modelIds.length}.<br> → Enter a number from 1 to ${modelIds.length}.<br> |
| CLI-138 | src/cli-image.mjs:115 | Codex configuration changed during image setup; retry to preserve the newer settings → Codex configuration changed during image setup; retry to preserve the newer settings |
| CLI-139 | src/cli-image.mjs:146 | Codex configuration changed during image cleanup; retry to preserve the newer settings → Codex configuration changed during image cleanup; retry to preserve the newer settings |
| CLI-140 | src/cli-image.mjs:167 | Local image service: ready (generation tool verified; no image generated).<br> → Local image service: ready (generation tool verified; no image generated).<br> |
| CLI-141 | src/cli-image.mjs:168 | Generate: available<br>Edit: ${readiness.editing ? "available" : "not advertised"}<br> → Generate: available<br>Edit: ${readiness.editing ? "available" : "not advertised"}<br> |
| CLI-142 | src/cli-image.mjs:168 | not advertised → not advertised |
| CLI-143 | src/cli-image.mjs:170 | Local image service: unavailable (${readiness.reason}). Start or restart ${commandName} to use images.<br> → Local image service: unavailable (${readiness.reason}). Start or restart ${commandName} to use images.<br> |
| CLI-144 | src/cli-image.mjs:192 | Image generation: disabled<br> → Image generation: disabled<br> |
| CLI-145 | src/cli-image.mjs:196 | Image generation: enabled<br>Endpoint: ${terminalCell(summary.endpoint)}<br>Model: ${terminalCell(summary.model)}<br>Protocol: ${terminalCell(summary.protocol)}<br> → Image generation: enabled<br>Endpoint: ${terminalCell(summary.endpoint)}<br>Model: ${terminalCell(summary.model)}<br>Protocol: ${terminalCell(summary.protocol)}<br> |
| CLI-146 | src/cli-image.mjs:197 | New image calls: paused by the WebUI preference; provider configuration is retained.<br> → New image calls: paused by the WebUI preference; provider configuration is retained.<br> |
| CLI-147 | src/cli-image.mjs:206 | ${result.changed ? "Disabled" : "Kept disabled"} image generation.<br> → ${result.changed ? "Disabled" : "Kept disabled"} image generation.<br> |
| CLI-148 | src/cli-image.mjs:206 | Disabled → Disabled |
| CLI-149 | src/cli-image.mjs:206 | Kept disabled → Kept disabled |
| CLI-150 | src/cli-image.mjs:208 | Kept user-modified image guidance. Existing image tool calls are now disabled.<br> → Kept user-modified image guidance. Existing image tool calls are now disabled.<br> |
| CLI-151 | src/cli-image.mjs:209 | Removed CCDX image guidance. Existing image tool calls are now disabled.<br> → Removed CCDX image guidance. Existing image tool calls are now disabled.<br> |
| CLI-152 | src/cli-image.mjs:212 | Unknown image command action: ${action} → Unknown image command action: ${action} |
| CLI-153 | src/cli-image.mjs:214 | ${commandName} enable-image requires an interactive terminal → ${commandName} enable-image requires an interactive terminal |
| CLI-154 | src/cli-image.mjs:220 | ${commandName} enable-image<br> → ${commandName} enable-image<br> |
| CLI-155 | src/cli-image.mjs:221 | Enter an HTTPS base URL (for example, https://api.example/v1) or a full /images/generations endpoint.<br> → Enter an HTTPS base URL (for example, https://api.example/v1) or a full /images/generations endpoint.<br> |
| CLI-156 | src/cli-image.mjs:222 | API base URL or endpoint${current ? ` [${current.endpoint}]` : ""}:  → Image service URL${current ? ` [${current.endpoint}]` : ""}:  |
| CLI-157 | src/cli-image.mjs:223 | Image API base URL or endpoint is required → Image API base URL or endpoint is required |
| CLI-158 | src/cli-image.mjs:228 | Image API key is required → Image API key is required |
| CLI-159 | src/cli-image.mjs:230 | Checking image API...<br> → Checking image API...<br> |
| CLI-160 | src/cli-image.mjs:255 | Enabled image generation with ${terminalCell(model)}.<br> → Enabled image generation with ${terminalCell(model)}.<br> |
| CLI-161 | src/cli-image.mjs:258 | Installed CCDX image guidance for new and existing tasks. Ask Codex to draw an image.<br> → Installed CCDX image guidance for new and existing tasks. Ask Codex to draw an image.<br> |
| CLI-162 | src/cli-image.mjs:259 | If the open task has not refreshed its skills, restart Codex App once.<br> → If the open task has not refreshed its skills, restart Codex App once.<br> |
| CLI-163 | src/cli-limits.mjs:9 | ${(value / MIB).toFixed(value % MIB === 0 ? 0 : 1)} MiB → ${(value / MIB).toFixed(value % MIB === 0 ? 0 : 1)} MiB |
| CLI-164 | src/cli-limits.mjs:26 | CCDX_MAX_DECODED_BODY_BYTES overrides saved limits; unset it before using ccdx limits --decoded → CCDX_MAX_DECODED_BODY_BYTES overrides saved limits; unset it before using ccdx limits --decoded |
| CLI-165 | src/cli-limits.mjs:30 | Unknown limits action: ${action} → Unknown limits action: ${action} |
| CLI-166 | src/cli-limits.mjs:43 | ccdx limits → ccdx limits |
| CLI-167 | src/cli-limits.mjs:44 | Configured decoded request body: ${mib(preference.bytes)} (${preference.source}) → Configured decoded request body: ${mib(preference.bytes)} (${preference.source}) |
| CLI-168 | src/cli-limits.mjs:48 | Raw request body: ${mib(runtime &amp;&amp; Number.isFinite(activeRaw) &amp;&amp; activeRaw &gt; 0 ? activeRaw : loadRuntimeConfig(env).maxBodyBytes)}${runtime ? " (running)" : " (configured)"} → Raw request body: ${mib(runtime &amp;&amp; Number.isFinite(activeRaw) &amp;&amp; activeRaw &gt; 0 ? activeRaw : loadRuntimeConfig(env).maxBodyBytes)}${runtime ? " (running)" : " (configured)"} |
| CLI-169 | src/cli-m365.mjs:28 | Provider status → Provider status |
| CLI-170 | src/cli-m365.mjs:36 | Microsoft 365: ${terminalCell(m.state &#124;&#124; "not running")}${m.reason ? ` (${terminalCell(m.reason)})` : ""} → Microsoft 365: ${terminalCell(m.state &#124;&#124; "not running")}${m.reason ? ` (${terminalCell(m.reason)})` : ""} |
| CLI-171 | src/cli-m365.mjs:37 | Account: ${terminalCell(m.account.login)} → Account: ${terminalCell(m.account.login)} |
| CLI-172 | src/cli-m365.mjs:38 | Models: ${models.claude &#124;&#124; 0} Claude / ${models.gpt &#124;&#124; 0} GPT (${models.source &#124;&#124; "unavailable"}) → Models: ${models.claude &#124;&#124; 0} Claude / ${models.gpt &#124;&#124; 0} GPT (${models.source &#124;&#124; "unavailable"}) |
| CLI-173 | src/cli-m365.mjs:39 | Claude gateway: ${claude.gateway &#124;&#124; "not running"}${claude.base_url ? ` / ${claude.base_url}` : ""} → Claude gateway: ${claude.gateway &#124;&#124; "not running"}${claude.base_url ? ` / ${claude.base_url}` : ""} |
| CLI-174 | src/cli-m365.mjs:40 | Claude detail: ${terminalCell(claude.reason)} → Claude detail: ${terminalCell(claude.reason)} |
| CLI-175 | src/cli-m365.mjs:41 | Claude requests: ${claude.requests.completed} completed / ${claude.requests.incomplete} incomplete / ${claude.requests.failed} failed / ${claude.requests.active} active → Claude requests: ${claude.requests.completed} completed / ${claude.requests.incomplete} incomplete / ${claude.requests.failed} failed / ${claude.requests.active} active |
| CLI-176 | src/cli-m365.mjs:42 | Claude Code: ${claude.clients?.code &#124;&#124; "unknown"}; Claude App: ${claude.clients?.app &#124;&#124; "unknown"} → Claude Code: ${claude.clients?.code &#124;&#124; "unknown"}; Claude App: ${claude.clients?.app &#124;&#124; "unknown"} |
| CLI-177 | src/cli-m365.mjs:43 | Codex provider: ${state.codex_provider &#124;&#124; "github"} (default: github) → Codex provider: ${state.codex_provider &#124;&#124; "github"} (default: github) |
| CLI-178 | src/cli-m365.mjs:52 | The running provider does not match the saved selection; restart ccdx before changing Auto-review → Saved and active sources differ.<br>Restart CCDX before changing review settings. |
| CLI-179 | src/cli-m365.mjs:69 | Use explicit provider/model arguments outside an interactive terminal → Choose the source and models with command arguments. |
| CLI-180 | src/cli-m365.mjs:77 | Microsoft 365 preference: ${saved.enabled ? "auto" : "off"}<br>Codex provider: ${selected.codex}<br>Runtime status unavailable; start or restart ccdx to inspect it.<br> → Microsoft 365 preference: ${saved.enabled ? "auto" : "off"}<br>Codex provider: ${selected.codex}<br>Runtime status unavailable; start or restart ccdx to inspect it.<br> |
| CLI-181 | src/cli-m365.mjs:83 | Codex provider:<br>  1. GitHub Copilot (default)<br>  2. Microsoft 365 (backup)<br> → Codex provider:<br>  1. GitHub Copilot (default)<br>  2. Microsoft 365 (backup)<br> |
| CLI-182 | src/cli-m365.mjs:84 | Select 1 or 2, or q to cancel:  → Choose 1 or 2; q cancels:  |
| CLI-183 | src/cli-m365.mjs:86 | Select 1 or 2 → Choose 1 or 2 |
| CLI-184 | src/cli-m365.mjs:91 | No M365 GPT models are available; the current provider was retained → No M365 GPT models available. The current source is unchanged. |
| CLI-185 | src/cli-m365.mjs:94 | ${label} model is not available: ${terminalCell(supplied)} → ${label} model is not available: ${terminalCell(supplied)} |
| CLI-186 | src/cli-m365.mjs:98 | Specify --${label === "Auto-review" ? "auto-review-model" : "model"} with an available M365 model: ${ids.join(", ")} → Specify --${label === "Auto-review" ? "auto-review-model" : "model"} with an available M365 model: ${ids.join(", ")} |
| CLI-187 | src/cli-m365.mjs:100 | ${label} model:<br>${ids.map((id, index) =&gt; `  ${index + 1}. ${id}${id === current ? " [current]" : ""}`).join("\n")}<br> → ${label} model:<br>${ids.map((id, index) =&gt; `  ${index + 1}. ${id}${id === current ? " [current]" : ""}`).join("\n")}<br> |
| CLI-188 | src/cli-m365.mjs:101 | Select a model${current ? ` [${ids.indexOf(current) + 1}]` : ""}, or q to cancel:  → Select a model${current ? ` [${ids.indexOf(current) + 1}]` : ""}, or q to cancel:  |
| CLI-189 | src/cli-m365.mjs:104 | Invalid model selection → Invalid model selection |
| CLI-190 | src/cli-m365.mjs:109 | M365 fast tier is not verified. Use Standard in Codex; existing threads keep their selected model until you change it.<br> → M365 fast tier is not verified. Use Standard in Codex; existing threads keep their selected model until you change it.<br> |
| CLI-191 | src/cli-m365.mjs:113 | Select ${model} in Codex. Auto-review uses ${autoReviewModel} / low on this provider.<br> → Select ${model} in Codex. Auto-review uses ${autoReviewModel} / low on this provider.<br> |
| CLI-192 | src/cli-m365.mjs:124 | M365 auto-discovery enabled. Run ccdx to start it.<br> → M365 auto-discovery enabled. Run ccdx to start it.<br> |
| CLI-193 | src/cli-m365.mjs:131 | Unknown M365 action → Unknown M365 action |
| CLI-194 | src/cli-models.mjs:23 | ${commandName} models → ${commandName} models |
| CLI-195 | src/cli-models.mjs:24 | ${catalog?.source === "catalog" ? "Available catalog" : "Live catalog"} from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable GPT models of ${Number(catalog?.advertised) &#124;&#124; 0} advertised → ${catalog?.source === "catalog" ? "Available catalog" : "Live catalog"} from ${safeText(catalog?.upstreamHost, "GitHub Copilot")}: ${models.length} selectable GPT models of ${Number(catalog?.advertised) &#124;&#124; 0} advertised |
| CLI-196 | src/cli-models.mjs:24 | Available catalog → Available catalog |
| CLI-197 | src/cli-models.mjs:24 | Live catalog → Live catalog |
| CLI-198 | src/cli-models.mjs:25 | Responses: ${responses}; Chat: ${chat} → Responses: ${responses}; Chat: ${chat} |
| CLI-199 | src/cli-models.mjs:32 | No selectable GPT models were advertised for this account → No selectable GPT models listed. |
| CLI-200 | src/cli-models.mjs:62 | No selectable GPT models were advertised for this account → No selectable GPT models listed. |
| CLI-201 | src/cli-models.mjs:75 | VENDOR → VENDOR |
| CLI-202 | src/cli-models.mjs:76 | MODEL → MODEL |
| CLI-203 | src/cli-models.mjs:77 | APIS → APIS |
| CLI-204 | src/cli-models.mjs:78 | PREVIEW → PREVIEW |
| CLI-205 | src/cli-models.mjs:81 | VENDOR/MODEL → VENDOR/MODEL |
| CLI-206 | src/cli-models.mjs:82 | APIS → APIS |
| CLI-207 | src/cli-models.mjs:83 | PREVIEW → PREVIEW |
| CLI-208 | src/cli-options.mjs:20 | auth status → auth status |
| CLI-209 | src/cli-options.mjs:22 | doctor config → doctor config |
| CLI-210 | src/cli-options.mjs:41 | Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")} → Unexpected argument${args.length === 1 ? "" : "s"}: ${args.join(" ")} |
| CLI-211 | src/cli-options.mjs:59 | Missing value for ${option} → Enter a value for ${option} |
| CLI-212 | src/cli-options.mjs:70 | Format must be table or plain: ${value} → Format must be table or plain: ${value} |
| CLI-213 | src/cli-options.mjs:93 | Unknown help topic: ${parts.join(" ")} → Unknown help topic: ${parts.join(" ")} |
| CLI-214 | src/cli-options.mjs:162 | M365 action must be status, models, switch, on, off or remove → M365 action must be status, models, switch, on, off or remove |
| CLI-215 | src/cli-options.mjs:165 | Provider must be github or m365 → Choose github or m365 |
| CLI-216 | src/cli-options.mjs:175 | Usage provider must be a valid provider ID → Enter a valid source ID. |
| CLI-217 | src/cli-options.mjs:192 | Use --limit or --clean in one cache command, not both → Use either --limit or --clean. |
| CLI-218 | src/cli-options.mjs:199 | Cache limit must be an integer MiB value or default: ${rawLimit} → Cache limit must be an integer MiB value or default: ${rawLimit} |
| CLI-219 | src/cli-options.mjs:216 | Decoded request-body limit must be an integer MiB value or default: ${rawLimit} → Decoded request-body limit must be an integer MiB value or default: ${rawLimit} |
| CLI-220 | src/cli-options.mjs:236 | Profile must be codex: ${profile} → Profile must be codex: ${profile} |
| CLI-221 | src/cli-options.mjs:244 | Missing auth action: expected status or login → Choose auth status or auth login. |
| CLI-222 | src/cli-options.mjs:262 | Missing auth login profile: expected claude → Choose the claude sign-in profile. |
| CLI-223 | src/cli-options.mjs:263 | Auth login profile must be claude: ${profile} → Auth login profile must be claude: ${profile} |
| CLI-224 | src/cli-options.mjs:266 | Unknown auth action: ${action} → Unknown auth action: ${action} |
| CLI-225 | src/cli-options.mjs:274 | Prediction action must be on, off, status, or fix → Choose prediction on, off, status or fix. |
| CLI-226 | src/cli-options.mjs:280 | Suggestion action must be on, off, model, or status → Suggestion action must be on, off, model, or status |
| CLI-227 | src/cli-options.mjs:282 | The CCDX prediction panel has been retired; use ccdx prediction for the separate optional native feature → The CCDX prediction panel has been retired; use ccdx prediction for the separate optional native feature |
| CLI-228 | src/cli-options.mjs:302 | Update source must be npm or github: ${source} → Choose npm or github. Received: ${source} |
| CLI-229 | src/cli-options.mjs:322 | Profile must be codex: ${profile} → Profile must be codex: ${profile} |
| CLI-230 | src/cli-options.mjs:335 | Unknown command or option: ${command} → Unknown command or option: ${command} |
| CLI-231 | src/cli-options.mjs:342 | ${name} must be an integer between ${min} and ${max} → ${name} must be an integer between ${min} and ${max} |
| CLI-232 | src/cli-options.mjs:345 | ${name} must be an integer between ${min} and ${max} → ${name} must be an integer between ${min} and ${max} |
| CLI-233 | src/cli-options.mjs:383 | Usage:<br>  ${name} [start] [--show-request-id] [--no-browser] [--verbose]<br><br>Starts or reuses the local adapter, updates Codex configuration, and attempts to open Codex App when auto-launch is enabled and supported. Interactive desktop starts also open WebUI once; --no-browser skips that attempt. After startup the terminal shows fixed status/returned usage; --verbose or --show-request-id retains request detail. → Usage:<br>  ${name} [start] [--show-request-id] [--no-browser] [--verbose]<br><br>- Starts or reuses the local adapter, updates Codex configuration, and attempts to open Codex App when auto-launch is enabled and supported.<br>- Interactive desktop starts also open WebUI once; --no-browser skips that attempt.<br>- After startup the terminal shows fixed status/returned usage; --verbose or --show-request-id retains request detail. |
| CLI-234 | src/cli-options.mjs:384 | Usage:<br>  ${name} auth status [--online] [--format table&#124;plain]<br><br>Shows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog. → Usage:<br>  ${name} auth status [--online] [--format table&#124;plain]<br><br>- Shows the saved GitHub Copilot account without exposing credentials.<br>- --online also verifies its entitlement and model catalog. |
| CLI-235 | src/cli-options.mjs:385 | Usage:<br>  ${name} auth status [--online] [--format table&#124;plain]<br><br>Shows the saved GitHub Copilot account without exposing credentials. --online also verifies its entitlement and model catalog. Interactive terminals use a table by default. → Usage:<br>  ${name} auth status [--online] [--format table&#124;plain]<br><br>- Shows the saved GitHub Copilot account without exposing credentials.<br>- --online also verifies its entitlement and model catalog.<br>- Interactive terminals use a table by default. |
| CLI-236 | src/cli-options.mjs:386 | Usage:<br>  ${name} doctor [--online] [--compat] [--fix] [--json]<br>  ${name} doctor config<br><br>Checks credentials, managed configuration, command launchers, adapter, enabled optional features and observed client catalog. Default is read-only; no inference requests. --online validates account entitlement; --compat sends minimal inference requests and consumes a small amount of Copilot usage, requiring successful model completion rather than HTTP 200 alone. --fix repairs owned Windows launchers and managed config, imports a verified existing credential only if none is saved, and asks the running adapter to repair enabled predictions once. No interactive login, client program edits, forced App restarts, policy changes or optional feature activation. Missing-credential repair can contact GitHub without --online. Changed existing config is backed up to config.toml.ccdx-doctor.bak. Partial repairs exit 1. --json emits a redacted report, including before_checks for repairs. App-internal cache and visible predictions are not externally verified. The config subcommand remains strictly read-only. → Usage:<br>  ${name} doctor [--online] [--compat] [--fix] [--json]<br>  ${name} doctor config<br><br>- Checks credentials, managed configuration, command launchers, adapter, enabled optional features and observed client catalog.<br>- Default is read-only; no inference requests.<br>- --online validates account entitlement; --compat sends minimal inference requests and consumes a small amount of Copilot usage, requiring successful model completion rather than HTTP 200 alone.<br>- --fix repairs owned Windows launchers and managed config, imports a verified existing credential only if none is saved, and asks the running adapter to repair enabled predictions once.<br>- No interactive login, client program edits, forced App restarts, policy changes or optional feature activation.<br>- Missing-credential repair can contact GitHub without --online.<br>- Changed existing config is backed up to config.toml.ccdx-doctor.bak.<br>- Partial repairs exit 1.<br>- --json emits a redacted report, including before_checks for repairs.<br>- App-internal cache and visible predictions are not externally verified.<br>- The config subcommand remains strictly read-only. |
| CLI-237 | src/cli-options.mjs:387 | Usage:<br>  ${name} doctor config<br><br>Reads ~/.codex/config.toml, checks TOML syntax and CCDX-managed settings, and previews the existing startup writer's changes. Does not merge Codex profiles or validate the complete installed Codex schema. No authentication, network requests, file writes, or adapter/GUI startup. Existing context_management=false is valid. Exit 1 for errors, 0 for OK/warnings; unsupported arguments exit 2. → Usage:<br>  ${name} doctor config<br><br>- Reads ~/.codex/config.toml, checks TOML syntax and CCDX-managed settings, and previews the existing startup writer's changes.<br>- Does not merge Codex profiles or validate the complete installed Codex schema.<br>- No authentication, network requests, file writes, or adapter/GUI startup.<br>- Existing context_management=false is valid.<br>- Exit 1 for errors, 0 for OK/warnings; unsupported arguments exit 2. |
| CLI-238 | src/cli-options.mjs:388 | Usage:<br>  ${name} status<br><br>Shows bounded runtime, routing, performance, queue, and cache metrics from a running adapter. → Usage:<br>  ${name} status<br><br>- Shows bounded runtime, routing, performance, queue, and cache metrics from a running adapter. |
| CLI-239 | src/cli-options.mjs:389 | Usage:<br>  ${name} models [--format table&#124;plain]<br><br>Shows GPT models for the selected Codex provider. GitHub performs a fresh read-only lookup; M365 uses its isolated catalog in the running service. Interactive terminals use a table by default. → Usage:<br>  ${name} models [--format table&#124;plain]<br><br>- Shows GPT models for the selected Codex provider.<br>- GitHub performs a fresh read-only lookup; M365 uses its isolated catalog in the running service.<br>- Interactive terminals use a table by default. |
| CLI-240 | src/cli-options.mjs:390 | Usage:<br>  ${name} usage [--format table&#124;plain] [--provider ID]<br><br>Summarizes local token usage metadata without reading prompt or completion content. Optional provider filtering separates sources; default totals include all recorded sources. Interactive terminals use a table by default. → Usage:<br>  ${name} usage [--format table&#124;plain] [--provider ID]<br><br>- Summarizes local token usage metadata without reading prompt or completion content.<br>- Optional provider filtering separates sources; default totals include all recorded sources.<br>- Interactive terminals use a table by default. |
| CLI-241 | src/cli-options.mjs:391 | Usage:<br>  ${name} cache<br>  ${name} cache --limit &lt;MiB&#124;default&gt;<br>  ${name} cache --clean [--history] [--yes]<br><br>Shows runtime cache use, saves and applies the shared response-history limit, or clears the rebuildable image-transform cache. --history also clears in-memory response history for all tasks and can make their next continuation fail, so interactive confirmation or --yes is required. Generated image files and saved Codex transcripts are never deleted. Short aliases: -128 sets 128 MiB and -clean equals --clean. → Usage:<br>  ${name} cache<br>  ${name} cache --limit &lt;MiB&#124;default&gt;<br>  ${name} cache --clean [--history] [--yes]<br><br>- Shows runtime cache use, saves and applies the shared response-history limit, or clears the rebuildable image-transform cache.<br>- --history also clears in-memory response history for all tasks and can make their next continuation fail, so interactive confirmation or --yes is required.<br>- Generated image files and saved Codex transcripts are never deleted.<br>- Short aliases: -128 sets 128 MiB and -clean equals --clean. |
| CLI-242 | src/cli-options.mjs:392 | Usage:<br>  ${name} limits<br>  ${name} limits --decoded &lt;MiB&#124;default&gt;<br><br>Shows configured and running request-body limits, or saves a decoded request-body limit from 128 to 512 MiB. The raw-body limit is unchanged. Restart ccdx to apply a saved change; no conversation or cache is cleared. Short alias: -256 sets 256 MiB. → Usage:<br>  ${name} limits<br>  ${name} limits --decoded &lt;MiB&#124;default&gt;<br><br>- Shows configured and running request-body limits, or saves a decoded request-body limit from 128 to 512 MiB.<br>- The raw-body limit is unchanged.<br>- Restart ccdx to apply a saved change; no conversation or cache is cleared.<br>- Short alias: -256 sets 256 MiB. |
| CLI-243 | src/cli-options.mjs:393 | Usage:<br>  ${name} animation<br><br>Previews all terminal activity animations together and selects the saved theme. Running CCDX 1.1.0+ applies it live; older services need a restart. → Usage:<br>  ${name} animation<br><br>- Previews all terminal activity animations together and selects the saved theme.<br>- Running CCDX 1.1.0+ applies it live; older services need a restart. |
| CLI-244 | src/cli-options.mjs:394 | Usage:<br>  ${name} enable-image<br><br>Interactively configures an HTTPS image API endpoint (base URLs are also accepted) and API key, detects its supported image model and protocol, installs CCDX image guidance, and checks the local image tool for Codex App without generating an image. A blank key preserves the saved key only for the same origin; a new origin requires explicit key entry. Concurrent unrelated config edits are preserved. → Usage:<br>  ${name} enable-image<br><br>- Interactively configures an HTTPS image API endpoint (base URLs are also accepted) and API key, detects its supported image model and protocol, installs CCDX image guidance, and checks the local image tool for Codex App without generating an image.<br>- A blank key preserves the saved key only for the same origin; a new origin requires explicit key entry.<br>- Concurrent unrelated config edits are preserved. |
| CLI-245 | src/cli-options.mjs:395 | Usage:<br>  ${name} disable-image<br><br>Disables the local CCDX image tool and removes its stored API credential and unmodified CCDX image guidance. → Usage:<br>  ${name} disable-image<br><br>- Disables the local CCDX image tool and removes its stored API credential and unmodified CCDX image guidance. |
| CLI-246 | src/cli-options.mjs:396 | Usage:<br>  ${name} image-status<br><br>Shows provider configuration and locally advertised generation/editing tools without generating an image or exposing its API key. → Usage:<br>  ${name} image-status<br><br>- Shows provider configuration and locally advertised generation/editing tools without generating an image or exposing its API key. |
| CLI-247 | src/cli-options.mjs:397 | Usage:<br>  ${name} auto-review-model<br><br>Select a Responses model, then an advertised reasoning effort. Enter keeps the default/current choice; q cancels both steps without saving. Effort 0 follows the client (low when omitted). Settings apply only to Auto-review on the next request; no client patch or restart is required for adapters running 0.9.13 or newer. → Usage:<br>  ${name} auto-review-model<br><br>- Select a Responses model, then an advertised reasoning effort.<br>- Enter keeps the default/current choice; q cancels both steps without saving.<br>- Effort 0 follows the client (low when omitted).<br>- Settings apply only to Auto-review on the next request; no client patch or restart is required for adapters running 0.9.13 or newer. |
| CLI-248 | src/cli-options.mjs:398 | The CCDX prediction panel has been retired. Run ${name} suggestion off to safely remove unchanged CCDX registrations. This cleanup does not change native predictions; see ${name} prediction --help for that separate opt-in feature. → The CCDX prediction panel has been retired. Run ${name} suggestion off to safely remove unchanged CCDX registrations. This cleanup does not change native predictions; see ${name} prediction --help for that separate opt-in feature. |
| CLI-249 | src/cli-options.mjs:399 | Usage:<br>  ${name} m365 [status&#124;models&#124;on&#124;off&#124;remove]<br>  ${name} m365 switch [github&#124;m365] [--model ID] [--auto-review-model ID]<br><br>M365 is discovered silently at startup on supported managed environments. Claude uses its separate local gateway. Codex stays on GitHub unless you explicitly switch. M365 switching requires a running compatible adapter and available GPT/Auto-review choices; it never substitutes unavailable models. Select an available model in Codex after switching an existing thread. Off restores only owned Claude settings and selects GitHub. Remove also clears the CCDX M365 profile, retaining a disabled preference and historical usage. System Microsoft sign-in, GitHub credentials, predictions and images are preserved. → Usage:<br>  ${name} m365 [status&#124;models&#124;on&#124;off&#124;remove]<br>  ${name} m365 switch [github&#124;m365] [--model ID] [--auto-review-model ID]<br><br>- M365 is discovered silently at startup on supported managed environments.<br>- Claude uses /anthropic on the same local port.<br>- Codex stays on GitHub unless you explicitly switch.<br>- M365 switching requires a running compatible adapter and available GPT/Auto-review choices; it never substitutes unavailable models.<br>- Select an available model in Codex after switching an existing thread.<br>- Off restores only owned Claude settings and selects GitHub.<br>- Remove also clears the CCDX M365 profile, retaining a disabled preference and historical usage.<br>- System Microsoft sign-in, GitHub credentials, predictions and images are preserved. |
| CLI-250 | src/cli-options.mjs:400 | Usage:<br>  ${name} prediction [status&#124;on&#124;off&#124;fix]<br><br>Optional native next-message predictions; off by default. macOS and Windows. Windows requires the registered official MSIX App, an initialized profile, Windows PowerShell and .NET Framework 4.7.2+; Git/OpenSSL is not required for prediction setup. Quit Codex before on/off, then restart ccdx. On adds private App-profile certificate trust and an App-only route for chatgpt.com and ab.chatgpt.com. HTTPS on those hosts is decrypted locally; only prediction configuration is changed. No client program files, OS trust, account permissions, MCP or Hooks are changed. Static HTTP/HTTPS/SOCKS5 proxies and bypass rules are preserved. Windows supports company PAC/WPAD; macOS dynamic PAC/WPAD remains unsupported. Static IPv4/IPv6 CIDRs match URL IP literals without DNS. The bridge port persists across restarts/updates; a busy saved port disables only predictions. Launch/reuse checks the App's actual route; an older random or missing route may require one full App quit. Official prediction configuration is preserved; the conversation's model is used. App updates require another compatibility check. Status distinguishes saved preference and observed config traffic from unverified candidate visibility.<br><br>Fix asks a compatible running CCDX adapter to repair the enabled bridge once on its saved port. It never enables predictions, renews certificates or force-restarts Codex. Healthy unchanged bridges are retained. Fix rechecks system proxy settings. Changed routes may need a normal App relaunch to reload cached PAC; failed rechecks preserve the previous bridge with a nonzero exit. Process environment variables and Node trust are not hot-reloaded; changed trust inputs need a CCDX service restart. Startup, status and doctor share sanitized environment diagnostics. Missing App routes require a normal full quit and ccdx launch; partial repair exits 1. An older adapter must first be upgraded and restarted once to gain this repair endpoint. → Usage:<br>  ${name} prediction [status&#124;on&#124;off&#124;fix]<br><br>- Optional native next-message predictions; off by default. macOS and Windows.<br>- Windows requires the registered official MSIX App, an initialized profile, Windows PowerShell and .NET Framework 4.7.2+; Git/OpenSSL is not required for prediction setup.<br>- Quit Codex before on/off, then restart ccdx.<br>- On adds private App-profile certificate trust and an App-only route for chatgpt.com and ab.chatgpt.com.<br>- HTTPS on those hosts is decrypted locally; only prediction configuration is changed.<br>- No client program files, OS trust, account permissions, MCP or Hooks are changed.<br>- Static HTTP/HTTPS/SOCKS5 proxies and bypass rules are preserved.<br>- Windows supports company PAC/WPAD; macOS dynamic PAC/WPAD remains unsupported.<br>- Static IPv4/IPv6 CIDRs match URL IP literals without DNS.<br>- The bridge port persists across restarts/updates; a busy saved port disables only predictions.<br>- Launch/reuse checks the App's actual route; an older random or missing route may require one full App quit.<br>- Official prediction configuration is preserved; the conversation's model is used.<br>- App updates require another compatibility check.<br>- Status distinguishes saved preference and observed config traffic from unverified candidate visibility.<br>- Fix asks a compatible running CCDX adapter to repair the enabled bridge once on its saved port.<br>- It never enables predictions, renews certificates or force-restarts Codex.<br>- Healthy unchanged bridges are retained.<br>- Fix rechecks system proxy settings.<br>- Changed routes may need a normal App relaunch to reload cached PAC; failed rechecks preserve the previous bridge with a nonzero exit.<br>- Process environment variables and Node trust are not hot-reloaded; changed trust inputs need a CCDX service restart.<br>- Startup, status and doctor share sanitized environment diagnostics.<br>- Missing App routes require a normal full quit and ccdx launch; partial repair exits 1.<br>- An older adapter must first be upgraded and restarted once to gain this repair endpoint. |
| CLI-251 | src/cli-options.mjs:401 | Usage:<br>  ${name} update [npm&#124;github] [--allow-remote]<br><br>Updates the global package from the configured npm registry or the latest stable GitHub release. With no source, an interactive terminal prompts for one. Windows uses system cmd.exe to run npm.cmd without changing PowerShell policy; use the .cmd entrypoint if scripts are blocked. GitHub installs require Git on PATH and dependencies may still use the configured npm registry. By default npm's remote-download policy is preserved. If npm reports EALLOWREMOTE for a trusted mirror tarball, --allow-remote explicitly permits URL dependencies for this one installation's entire dependency tree; it is not a hostname allowlist. No .npmrc, registry or persistent policy is changed, and failed installations are not retried automatically. Use this only if company policy permits it. Restart the running adapter after installation. → Usage:<br>  ${name} update [npm&#124;github] [--allow-remote]<br><br>- Updates the global package from the configured npm registry or the latest stable GitHub release.<br>- With no source, an interactive terminal prompts for one.<br>- Windows uses system cmd.exe to run npm.cmd without changing PowerShell policy; use the .cmd entrypoint if scripts are blocked.<br>- GitHub installs require Git on PATH and dependencies may still use the configured npm registry.<br>- By default npm's remote-download policy is preserved.<br>- If npm reports EALLOWREMOTE for a trusted mirror tarball, --allow-remote explicitly permits URL dependencies for this one installation's entire dependency tree; it is not a hostname allowlist.<br>- No .npmrc, registry or persistent policy is changed, and failed installations are not retried automatically.<br>- Use this only if company policy permits it.<br>- Restart the running adapter after installation. |
| CLI-252 | src/cli-options.mjs:402 | Usage:<br>  ${name} --version → Usage:<br>  ${name} --version |
| CLI-253 | src/cli-options.mjs:411 | Usage:<br>  ${name} [start] [--show-request-id] [--no-browser] [--verbose]<br>  ${name} auth status [--online] [--format table&#124;plain]<br>  ${name} doctor [--online] [--compat] [--fix] [--json]<br>  ${name} doctor config<br>  ${name} status<br>  ${name} models [--format table&#124;plain]<br>  ${name} usage [--format table&#124;plain] [--provider ID]<br>  ${name} cache [--limit &lt;MiB&#124;default&gt; &#124; --clean [--history] [--yes]]<br>  ${name} limits [--decoded &lt;MiB&#124;default&gt;]<br>  ${name} animation<br>  ${name} enable-image<br>  ${name} disable-image<br>  ${name} image-status<br>  ${name} auto-review-model<br>  ${name} prediction [status&#124;on&#124;off&#124;fix]<br>  ${name} m365 [status&#124;models&#124;switch&#124;on&#124;off&#124;remove]<br>  ${name} update [npm&#124;github] [--allow-remote]<br>  ${name} --version<br>  ${name} --help<br><br>Commands:<br>  start              Start or reuse the adapter and configure Codex<br>  auth               Inspect the saved GitHub Copilot account<br>  doctor             Diagnose local config; optional live and inference checks<br>  status             Show runtime routing, performance, queue, and cache health<br>  models             Show the selected Codex provider's GPT model catalog<br>  usage              Summarize locally recorded token usage<br>  cache              Inspect, size, or clear bounded runtime caches<br>  limits             Inspect or configure the decoded request-body limit<br>  animation          Select the terminal activity animation<br>  enable-image       Configure and enable the optional image provider<br>  disable-image      Disable the image provider and remove its credential<br>  image-status       Show the optional image provider status<br>  auto-review-model  Select the Codex Auto-review model and reasoning effort<br>  prediction         Toggle optional native next-message predictions<br>  m365               Manage M365 Claude access and the optional Codex backup<br>  update             Update the global package from npm or GitHub<br><br>Run ${name} &lt;command&gt; --help for command details. → Usage:<br>  ${name} [start] [--show-request-id] [--no-browser] [--verbose]<br>  ${name} auth status [--online] [--format table&#124;plain]<br>  ${name} doctor [--online] [--compat] [--fix] [--json]<br>  ${name} doctor config<br>  ${name} status<br>  ${name} models [--format table&#124;plain]<br>  ${name} usage [--format table&#124;plain] [--provider ID]<br>  ${name} cache [--limit &lt;MiB&#124;default&gt; &#124; --clean [--history] [--yes]]<br>  ${name} limits [--decoded &lt;MiB&#124;default&gt;]<br>  ${name} animation<br>  ${name} enable-image<br>  ${name} disable-image<br>  ${name} image-status<br>  ${name} auto-review-model<br>  ${name} prediction [status&#124;on&#124;off&#124;fix]<br>  ${name} m365 [status&#124;models&#124;switch&#124;on&#124;off&#124;remove]<br>  ${name} update [npm&#124;github] [--allow-remote]<br>  ${name} --version<br>  ${name} --help<br><br>Commands:<br>  start              Start or reuse the adapter and configure Codex<br>  auth               Inspect the saved GitHub Copilot account<br>  doctor             Diagnose local config; optional live and inference checks<br>  status             Show runtime routing, performance, queue, and cache health<br>  models             Show the selected Codex provider's GPT model catalog<br>  usage              Summarize locally recorded token usage<br>  cache              Inspect, size, or clear bounded runtime caches<br>  limits             Inspect or configure the decoded request-body limit<br>  animation          Select the terminal activity animation<br>  enable-image       Configure and enable the optional image provider<br>  disable-image      Disable the image provider and remove its credential<br>  image-status       Show the optional image provider status<br>  auto-review-model  Select the Codex Auto-review model and reasoning effort<br>  prediction         Toggle optional native next-message predictions<br>  m365               Manage M365 Claude access and the optional Codex backup<br>  update             Update the global package from npm or GitHub<br><br>Run ${name} &lt;command&gt; --help for command details. |
| CLI-254 | src/cli-status.mjs:69 | ${label} ${mode}: ${token}, ${count(models.models)} models (${source}) → ${label} ${mode}: ${token}, ${count(models.models)} models (${source}) |
| CLI-255 | src/cli-status.mjs:73 | Codex → Codex |
| CLI-256 | src/cli-status.mjs:74 | Codex (Microsoft 365 backup) → Codex (Microsoft 365 backup) |
| CLI-257 | src/cli-status.mjs:106 | returned HTTP ${response.status} → returned HTTP ${response.status} |
| CLI-258 | src/cli-status.mjs:112 | returned invalid JSON → returned invalid JSON |
| CLI-259 | src/cli-status.mjs:118 | returned an incompatible status payload → returned an incompatible status payload |
| CLI-260 | src/cli-status.mjs:131 | Could not read adapter status at ${baseUrl}: ${reason}${nextStep} → Could not read adapter status at ${baseUrl}: ${reason}${nextStep} |
| CLI-261 | src/cli-status.mjs:151 | Adapter ${data.version} is running at ${baseUrl} (PID ${data.pid}, uptime ${duration(data.uptime_ms)}) → Adapter ${data.version} is running at ${baseUrl} (PID ${data.pid}, uptime ${duration(data.uptime_ms)}) |
| CLI-262 | src/cli-status.mjs:152 | Adapter ${data.version} is running at ${baseUrl}, but this CLI is ${cliVersion}; stop the running adapter before switching versions → Adapter ${data.version} is running at ${baseUrl}, but this CLI is ${cliVersion}; stop the running adapter before switching versions |
| CLI-263 | src/cli-status.mjs:155 | ${commandName} status → ${commandName} status |
| CLI-264 | src/cli-status.mjs:157 | Requests: ${count(requests.completed)}/${count(requests.total)} completed, ${count(requests.active)} active, ${count(requests.status_4xx)} 4xx, ${count(requests.status_5xx)} 5xx, ${count(requests.aborted)} aborted → Requests: ${count(requests.completed)}/${count(requests.total)} completed, ${count(requests.active)} active, ${count(requests.status_4xx)} 4xx, ${count(requests.status_5xx)} 5xx, ${count(requests.aborted)} aborted |
| CLI-265 | src/cli-status.mjs:158 | Responses stream: TTFT avg ${firstOutputLatency(performance.ttft_ms)} (${count(performance.ttft_ms?.samples)} samples), output avg ${outputRate(performance.output_tokens_per_second)} (${count(performance.output_tokens_per_second?.samples)} samples; gateway estimate) → Responses stream: TTFT avg ${firstOutputLatency(performance.ttft_ms)} (${count(performance.ttft_ms?.samples)} samples), output avg ${outputRate(performance.output_tokens_per_second)} (${count(performance.output_tokens_per_second?.samples)} samples; gateway estimate) |
| CLI-266 | src/cli-status.mjs:159 | Model outcomes: ${count(terminalOutcomes.completed)} completed, ${count(terminalOutcomes.incomplete)} incomplete, ${count(terminalOutcomes.failed)} failed, ${count(terminalOutcomes.cancelled)} cancelled, ${count(terminalOutcomes.unknown)} without terminal → Model outcomes: ${count(terminalOutcomes.completed)} completed, ${count(terminalOutcomes.incomplete)} incomplete, ${count(terminalOutcomes.failed)} failed, ${count(terminalOutcomes.cancelled)} cancelled, ${count(terminalOutcomes.unknown)} without terminal |
| CLI-267 | src/cli-status.mjs:160 | Admission: ${count(admission.activeRequests)} active, ${count(admission.queued)} queued, ${count(admission.rejected)} rejected, ${count(admission.timedOut)} timed out, wait avg ${latency(admission.waitMsAvg)} → Admission: ${count(admission.activeRequests)} active, ${count(admission.queued)} queued, ${count(admission.rejected)} rejected, ${count(admission.timedOut)} timed out, wait avg ${latency(admission.waitMsAvg)} |
| CLI-268 | src/cli-status.mjs:161 | Memory: RSS ${mebibytes(processStats.rss_bytes)}, heap ${mebibytes(processStats.heap_used_bytes)} → Memory: RSS ${mebibytes(processStats.rss_bytes)}, heap ${mebibytes(processStats.heap_used_bytes)} |
| CLI-269 | src/cli-status.mjs:162 | History: ${mebibytes(history.bytes)} / ${mebibytes(limits.response_history_max_bytes)}, ${count(history.entries)} entries, ${count(history.evicted)} evicted ID markers → Conversation buffer: ${mebibytes(history.bytes)} / ${mebibytes(limits.response_history_max_bytes)}, ${count(history.entries)} entries, ${count(history.evicted)} evicted ID markers |
| CLI-270 | src/cli-status.mjs:163 | Image cache: ${count(images.cache_entries)} entries, ${cacheHitRate(images)} hits, ${mebibytes(images.cache_bytes)} / ${mebibytes(images.cache_max_bytes)} → Image cache: ${count(images.cache_entries)} entries, ${cacheHitRate(images)} hits, ${mebibytes(images.cache_bytes)} / ${mebibytes(images.cache_max_bytes)} |
| CLI-271 | src/cli-status.mjs:169 | ${nearLimit ? "History near limit" : "History diagnostics"}: largest tree ${mebibytes(history.largest_tree_bytes)} across ${count(history.tree_count)} trees; ${count(history.lookup_misses)} lookup misses, ${count(history.evicted_lookup_misses)} for evicted IDs → ${nearLimit ? "History near limit" : "History diagnostics"}: largest tree ${mebibytes(history.largest_tree_bytes)} across ${count(history.tree_count)} trees; ${count(history.lookup_misses)} lookup misses, ${count(history.evicted_lookup_misses)} for evicted IDs |
| CLI-272 | src/cli-status.mjs:169 | History near limit → History near limit |
| CLI-273 | src/cli-status.mjs:169 | History diagnostics → History diagnostics |
| CLI-274 | src/cli-status.mjs:172 | Visual history: ${count(imageHistory.active_recovery_trees)} recovery trees, ${count(imageHistory.adapted_requests)} adapted requests, ${count(imageHistory.historical_images_omitted)} older images omitted, ${count(imageHistory.timeouts_recorded)} timeouts → Visual history: ${count(imageHistory.active_recovery_trees)} recovery trees, ${count(imageHistory.adapted_requests)} adapted requests, ${count(imageHistory.historical_images_omitted)} older images omitted, ${count(imageHistory.timeouts_recorded)} timeouts |
| CLI-275 | src/cli-status.mjs:176 | Image generation: ${count(generation.active)} active, ${count(generation.succeeded)} succeeded, ${count(generation.failed)} failed (${count(generation.busy)} busy), ${count(generation.cancelled)} cancelled, ${count(generation.delivery_failures)} delivery failures → Image generation: ${count(generation.active)} active, ${count(generation.succeeded)} succeeded, ${count(generation.failed)} failed (${count(generation.busy)} busy), ${count(generation.cancelled)} cancelled, ${count(generation.delivery_failures)} delivery failures |
| CLI-276 | src/cli-status.mjs:182 | ${name === "usage" ? "Usage" : "Debug"} logging: ${count(logging.pending_records)} pending (${mebibytes(logging.pending_bytes)}), ${count(logging.dropped_records)} dropped, ${count(logging.write_failures)} write failures → ${name === "usage" ? "Usage" : "Debug"} logging: ${count(logging.pending_records)} pending (${mebibytes(logging.pending_bytes)}), ${count(logging.dropped_records)} dropped, ${count(logging.write_failures)} write failures |
| CLI-277 | src/cli-status.mjs:182 | Usage → Usage |
| CLI-278 | src/cli-status.mjs:182 | Debug → Debug |
| CLI-279 | src/cli-status.mjs:186 | Response failures: ${count(responseFailures.total)} observed, ${count(responseFailures.retried)} compatibility retries → Response failures: ${count(responseFailures.total)} observed, ${count(responseFailures.retried)} compatibility retries |
| CLI-280 | src/cli-status.mjs:192 |  [retried:${retryPolicy}] →  [retried:${retryPolicy}] |
| CLI-281 | src/cli-status.mjs:196 | HTTP failures: ${count(data.http_errors.total)} observed (separate from model terminal events) → HTTP failures: ${count(data.http_errors.total)} observed (separate from model terminal events) |
| CLI-282 | src/cli-status.mjs:198 | HTTP categories: ${count(categories.inference)} inference, ${count(categories.protocol)} unsupported MCP methods, ${count(categories.route)} unmatched routes, ${count(categories.other)} other → HTTP categories: ${count(categories.inference)} inference, ${count(categories.protocol)} unsupported MCP methods, ${count(categories.route)} unmatched routes, ${count(categories.other)} other |
| CLI-283 | src/cli-status.mjs:200 | HTTP ${count(failure.http_status)} ${terminalCell(failure.model)} ${terminalCell(failure.code)}${failure.parameter ? ` param=${terminalCell(failure.parameter)}` : ""}; ${terminalCell(failure.origin)}; ${count(failure.upstream_attempts)} attempts → HTTP ${count(failure.http_status)} ${terminalCell(failure.model)} ${terminalCell(failure.code)}${failure.parameter ? ` param=${terminalCell(failure.parameter)}` : ""}; ${terminalCell(failure.origin)}; ${count(failure.upstream_attempts)} attempts |
| CLI-284 | src/cli-status.mjs:200 |  param=${terminalCell(failure.parameter)} →  param=${terminalCell(failure.parameter)} |
| CLI-285 | src/cli-status.mjs:203 | Models: ${count(models.models)} total; Copilot token ${copilot.token_cached ? `cached (${duration(copilot.token_expires_in_ms)} remaining)` : "not cached"} → Models: ${count(models.models)} total; Copilot token ${copilot.token_cached ? `cached (${duration(copilot.token_expires_in_ms)} remaining)` : "not cached"} |
| CLI-286 | src/cli-status.mjs:203 | cached (${duration(copilot.token_expires_in_ms)} remaining) → cached (${duration(copilot.token_expires_in_ms)} remaining) |
| CLI-287 | src/cli-status.mjs:203 | not cached → not cached |
| CLI-288 | src/cli-status.mjs:206 | Native predictions: ${prediction.configured ? "on" : "off"}; bridge ${prediction.bridge}; client route ${prediction.client_route}; visible candidate unknown → Native predictions: ${prediction.configured ? "on" : "off"}; bridge ${prediction.bridge}; client route ${prediction.client_route}; visible candidate unknown |
| CLI-289 | src/cli-status.mjs:207 | Prediction self-check: App route ${prediction.launch_route}; persistent route ${prediction.persistence &#124;&#124; "unknown"}; ${count(prediction.recovery?.recovered)} bridge recoveries, ${count(prediction.recovery?.attempts)}/3 attempts used → Prediction self-check: App route ${prediction.launch_route}; persistent route ${prediction.persistence &#124;&#124; "unknown"}; ${count(prediction.recovery?.recovered)} bridge recoveries, ${count(prediction.recovery?.attempts)}/3 attempts used |
| CLI-290 | src/cli-status.mjs:212 | Profile: ${profileSummary("Codex", data.profiles.codex)} → Profile: ${profileSummary("Codex", data.profiles.codex)} |
| CLI-291 | src/cli-status.mjs:215 | Routing: /v1/responses -&gt; ${routingTarget(data.routing.responses)} → Routing: /v1/responses -&gt; ${routingTarget(data.routing.responses)} |
| CLI-292 | src/cli-status.mjs:219 | Microsoft 365: ${terminalCell(m365.state)}; ${count(m365.models?.claude)} Claude, ${count(m365.models?.gpt)} GPT; gateway ${terminalCell(m365.claude?.gateway &#124;&#124; "unavailable")} → Microsoft 365: ${terminalCell(m365.state)}; ${count(m365.models?.claude)} Claude, ${count(m365.models?.gpt)} GPT; gateway ${terminalCell(m365.claude?.gateway &#124;&#124; "unavailable")} |
| CLI-293 | src/cli-status.mjs:220 | Microsoft 365 detail: ${terminalCell(m365.reason)} → Microsoft 365 detail: ${terminalCell(m365.reason)} |
| CLI-294 | src/cli-status.mjs:222 | Limits: request body ${mebibytes(limits.max_body_bytes)}, decoded body ${mebibytes(limits.max_decoded_body_bytes)} → Limits: request body ${mebibytes(limits.max_body_bytes)}, decoded body ${mebibytes(limits.max_decoded_body_bytes)} |
| CLI-295 | src/cli-status.mjs:225 | Latest request context: wire ${contextValue(recentContext.payload_bytes, mebibytes)}, ${contextValue(recentContext.images, count)} images, input ${contextValue(recentContext.input_tokens, count)} tokens / window ${contextValue(recentContext.context_window_tokens, count)} (reported metadata, not live session occupancy) → Latest request context: wire ${contextValue(recentContext.payload_bytes, mebibytes)}, ${contextValue(recentContext.images, count)} images, input ${contextValue(recentContext.input_tokens, count)} tokens / window ${contextValue(recentContext.context_window_tokens, count)} (reported metadata, not live session occupancy) |
| CLI-296 | src/codex-client-doctor.mjs:31 | ChatGPT.app → ChatGPT.app |
| CLI-297 | src/codex-client-doctor.mjs:31 | Codex.app → Codex.app |
| CLI-298 | src/codex-client-doctor.mjs:36 | Installed ${name}: App version ${version} → Installed ${name}: App version ${version} |
| CLI-299 | src/codex-client-doctor.mjs:46 | Running ${app.name}: PID ${app.pids.join(", ")}; fully quit with Command-Q before reopening (closing the window may keep it running) → Running ${app.name}: PID ${app.pids.join(", ")}; fully quit with Command-Q before reopening (closing the window may keep it running) |
| CLI-300 | src/codex-client-doctor.mjs:47 | No running Codex/ChatGPT App process observed → No running Codex/ChatGPT App process observed |
| CLI-301 | src/codex-client-doctor.mjs:48 | Running Codex App processes could not be inspected → Running Codex App processes could not be inspected |
| CLI-302 | src/codex-client-doctor.mjs:54 | Running adapter ${data.version}; upstream model directory source: ${source} → Running adapter ${data.version}; upstream model directory source: ${source} |
| CLI-303 | src/codex-client-doctor.mjs:60 | Running adapter does not expose client-catalog diagnostics; upgrade and restart CCDX → Running adapter does not expose client-catalog diagnostics; upgrade and restart CCDX |
| CLI-304 | src/codex-client-doctor.mjs:63 | ChatGPT.app → ChatGPT.app |
| CLI-305 | src/codex-client-doctor.mjs:63 | Codex.app → Codex.app |
| CLI-306 | src/codex-client-doctor.mjs:63 | custom binary → custom binary |
| CLI-307 | src/codex-client-doctor.mjs:64 | Last catalog request: client ${version}, ${app}, ${observed.source === "bundled" ? "bundled" : "unavailable"}; version match ${observed.matched === true ? "observed" : "not verified"} → Last catalog request: client ${version}, ${app}, ${observed.source === "bundled" ? "bundled" : "unavailable"}; version match ${observed.matched === true ? "observed" : "not verified"} |
| CLI-308 | src/codex-client-doctor.mjs:65 | No client model-catalog request observed by this adapter → No client model-catalog request observed by this adapter |
| CLI-309 | src/codex-client-doctor.mjs:66 | Client model-catalog diagnostics unavailable from the running adapter → Client model-catalog diagnostics unavailable from the running adapter |
| CLI-310 | src/codex-client-doctor.mjs:68 | App-internal model cache is not externally verified; process age alone does not prove a stale catalog → App-internal model cache is not externally verified; process age alone does not prove a stale catalog |
| CLI-311 | src/codex-config-doctor.mjs:62 | Startup configuration cannot be edited safely; review the file before starting ccdx → Startup configuration cannot be edited safely; review the file before starting ccdx |
| CLI-312 | src/codex-config-doctor.mjs:64 | No startup configuration changes required → No startup configuration changes required |
| CLI-313 | src/codex-config-doctor.mjs:69 | Startup configuration preview is not valid TOML; review the file before starting ccdx → Startup configuration preview is not valid TOML; review the file before starting ccdx |
| CLI-314 | src/codex-config-doctor.mjs:72 | Startup preview would change settings outside CCDX's managed keys; review the file before starting ccdx → Startup preview would change settings outside CCDX's managed keys; review the file before starting ccdx |
| CLI-315 | src/codex-config-doctor.mjs:84 | ${label} is missing → ${label} is missing |
| CLI-316 | src/codex-config-doctor.mjs:85 | ${label} must be a string → ${label} must be a string |
| CLI-317 | src/codex-config-doctor.mjs:88 | ${label} points to ${expected} → ${label} points to ${expected} |
| CLI-318 | src/codex-config-doctor.mjs:89 | ${label} differs from the CCDX address ${expected} → ${label} differs from the CCDX address ${expected} |
| CLI-319 | src/codex-config-doctor.mjs:100 | Codex config not found at ${filePath} → Codex config not found at ${filePath} |
| CLI-320 | src/codex-config-doctor.mjs:104 | Cannot read UTF-8 Codex config at ${filePath} → Cannot read UTF-8 Codex config at ${filePath} |
| CLI-321 | src/codex-config-doctor.mjs:115 | Invalid TOML in ${filePath}${location} → Invalid TOML in ${filePath}${location} |
| CLI-322 | src/codex-config-doctor.mjs:120 | Codex config is readable TOML: ${filePath} → Codex config is readable TOML: ${filePath} |
| CLI-323 | src/codex-config-doctor.mjs:126 | ${key} is missing → ${key} is missing |
| CLI-324 | src/codex-config-doctor.mjs:128 | ${key} = ${value} (existing value retained) → ${key} = ${value} (existing value retained) |
| CLI-325 | src/codex-config-doctor.mjs:129 | ${key} must be a positive TOML integer → ${key} must be a positive TOML integer |
| CLI-326 | src/codex-config-doctor.mjs:134 | model_auto_compact_token_limit is not below model_context_window; review the custom limits → model_auto_compact_token_limit is not below model_context_window; review the custom limits |
| CLI-327 | src/codex-config-doctor.mjs:140 | shell_environment_policy and its set value must be TOML tables → shell_environment_policy and its set value must be TOML tables |
| CLI-328 | src/codex-config-doctor.mjs:142 | Optional shell_environment_policy.set table is absent; existing files do not require it → Optional shell_environment_policy.set table is absent; existing files do not require it |
| CLI-329 | src/codex-config-doctor.mjs:146 | Codex shell OPENAI_API_KEY placeholder is missing → Codex shell OPENAI_API_KEY placeholder is missing |
| CLI-330 | src/codex-config-doctor.mjs:148 | Codex shell OPENAI_API_KEY must be a string (value hidden) → Codex shell OPENAI_API_KEY must be a string (value hidden) |
| CLI-331 | src/codex-config-doctor.mjs:150 | Codex shell OPENAI_API_KEY uses the dummy placeholder → Codex shell OPENAI_API_KEY uses the dummy placeholder |
| CLI-332 | src/codex-config-doctor.mjs:151 | Codex shell OPENAI_API_KEY differs from the dummy placeholder (value hidden) → Codex shell OPENAI_API_KEY differs from the dummy placeholder (value hidden) |
| CLI-333 | src/codex-config-doctor.mjs:157 | features must be a TOML table → features must be a TOML table |
| CLI-334 | src/codex-config-doctor.mjs:159 | features.context_management is missing; see the startup preview for whether it will be added → features.context_management is missing; see the startup preview for whether it will be added |
| CLI-335 | src/codex-config-doctor.mjs:161 | features.context_management = ${management} (${management ? "enabled" : "explicitly disabled"}; retained) → features.context_management = ${management} (${management ? "enabled" : "explicitly disabled"}; retained) |
| CLI-336 | src/codex-config-doctor.mjs:163 | Structured context-management settings are retained; installed Codex support is not verified → Structured context-management settings are retained; installed Codex support is not verified |
| CLI-337 | src/codex-config-doctor.mjs:165 | features.context_management must be a boolean for the basic feature flag → features.context_management must be a boolean for the basic feature flag |
| CLI-338 | src/doctor-compat.mjs:38 | Doctor response → Doctor response |
| CLI-339 | src/doctor-compat.mjs:46 | HTTP ${resp.status}${detail ? `: ${detail}` : ""} → HTTP ${resp.status}${detail ? `: ${detail}` : ""} |
| CLI-340 | src/doctor-compat.mjs:63 | ${label} passed (${Date.now() - started}ms) → ${label} passed (${Date.now() - started}ms) |
| CLI-341 | src/doctor-compat.mjs:67 | ${label} failed: ${reason} → ${label} failed: ${reason} |
| CLI-342 | src/doctor-compat.mjs:74 | response body is missing id or output → response body is missing id or output |
| CLI-343 | src/doctor-compat.mjs:76 | model response did not complete successfully → model response did not complete successfully |
| CLI-344 | src/doctor-compat.mjs:85 | response body is missing valid compaction state → response body is missing valid compaction state |
| CLI-345 | src/doctor-compat.mjs:102 | model list is empty → model list is empty |
| CLI-346 | src/doctor-compat.mjs:109 | Compatibility Responses check failed: no GPT model advertises /responses → Compatibility Responses check failed: no GPT model advertises /responses |
| CLI-347 | src/doctor-compat.mjs:145 | stream did not finish with one valid response.completed → stream did not finish with one valid response.completed |
| CLI-348 | src/doctor-repair.mjs:17 | ${id}: repair could not be verified; no retry or forced restart was performed → ${id}: repair could not be verified; no retry or forced restart was performed |
| CLI-349 | src/doctor-repair.mjs:21 | Command launcher: no repair required on this installation → Command launcher: no repair required on this installation |
| CLI-350 | src/doctor-repair.mjs:35 | GitHub credentials preserved; Codex currently uses Microsoft 365 → GitHub credentials preserved; Codex currently uses Microsoft 365 |
| CLI-351 | src/doctor-repair.mjs:36 | Saved GitHub credential retained; use doctor --online to verify access → Saved GitHub credential retained; use doctor --online to verify access |
| CLI-352 | src/doctor-repair.mjs:43 | Predictions are off; no optional feature was enabled → Predictions are off; no optional feature was enabled |
| CLI-353 | src/doctor-repair.mjs:46 | Prediction repair: ${result.status}; suggestion visibility is not verified; no App was restarted → Prediction repair: ${result.status}; suggestion visibility is not verified; no App was restarted |
| CLI-354 | src/doctor.mjs:55 | GitHub token not found at ${displayPath(home, filePath)} → GitHub token not found at ${displayPath(home, filePath)} |
| CLI-355 | src/doctor.mjs:58 | GitHub token file is empty at ${displayPath(home, filePath)} → GitHub token file is empty at ${displayPath(home, filePath)} |
| CLI-356 | src/doctor.mjs:62 | GitHub token found${account} → GitHub token found${account} |
| CLI-357 | src/doctor.mjs:68 | Codex authentication profile uses the legacy path → Codex authentication profile uses the legacy path |
| CLI-358 | src/doctor.mjs:75 | Doctor profile must be codex: ${profile} → Doctor profile must be codex: ${profile} |
| CLI-359 | src/doctor.mjs:91 | Online Copilot check failed while reading the local credential → Online Copilot check failed while reading the local credential |
| CLI-360 | src/doctor.mjs:95 | Online Copilot check skipped because the GitHub token is missing → Online Copilot check skipped because the GitHub token is missing |
| CLI-361 | src/doctor.mjs:109 | GitHub Copilot authentication failed: ${validation.reason}${statusText} → GitHub Copilot authentication failed: ${validation.reason}${statusText} |
| CLI-362 | src/doctor.mjs:124 | GitHub Copilot access verified for ${validation.login &#124;&#124; "current account"} → Copilot access checked: ${validation.login &#124;&#124; "current account"} |
| CLI-363 | src/doctor.mjs:125 | Copilot models endpoint returned HTTP ${modelResp.status} → Copilot models endpoint returned HTTP ${modelResp.status} |
| CLI-364 | src/doctor.mjs:132 | GitHub Copilot access verified for ${validation.login &#124;&#124; "current account"} → Copilot access checked: ${validation.login &#124;&#124; "current account"} |
| CLI-365 | src/doctor.mjs:133 | Copilot models endpoint returned no valid model directory despite HTTP 200 → Copilot models endpoint returned no valid model directory despite HTTP 200 |
| CLI-366 | src/doctor.mjs:136 | GitHub Copilot access verified for ${validation.login &#124;&#124; "current account"} → Copilot access checked: ${validation.login &#124;&#124; "current account"} |
| CLI-367 | src/doctor.mjs:137 | Copilot models endpoint returned ${validModels.length} models → Copilot listed ${validModels.length} models |
| CLI-368 | src/doctor.mjs:144 | Online Copilot check failed: ${reason} → Online Copilot check failed: ${reason} |
| CLI-369 | src/doctor.mjs:208 | Inactive GitHub provider: ${check.message} → Inactive GitHub provider: ${check.message} |
| CLI-370 | src/doctor.mjs:210 | Runtime: Node ${process.version}, ${platform}/${process.arch} → Runtime: Node ${process.version}, ${platform}/${process.arch} |
| CLI-371 | src/doctor.mjs:213 | Codex provider: Microsoft 365; GitHub credentials are retained independently → Codex provider: Microsoft 365; GitHub credentials are retained independently |
| CLI-372 | src/doctor.mjs:217 | Windows command launcher: ${command.status}; PowerShell policy unchanged → Windows command launcher: ${command.status}; PowerShell policy unchanged |
| CLI-373 | src/doctor.mjs:221 | Predictions are off; optional routing checks skipped → Predictions are off; optional routing checks skipped |
| CLI-374 | src/doctor.mjs:225 | Native predictions require macOS or Windows; existing settings preserved → Native predictions require macOS or Windows; existing settings preserved |
| CLI-375 | src/doctor.mjs:226 | Prediction environment could not be verified; existing routing and trust settings preserved → Prediction environment could not be verified; existing routing and trust settings preserved |
| CLI-376 | src/doctor.mjs:226 | ccdx prediction status → ccdx prediction status |
| CLI-377 | src/doctor.mjs:230 | Image provider configuration is invalid; core service is unaffected → Image provider configuration is invalid; core service is unaffected |
| CLI-378 | src/doctor.mjs:230 | ccdx image-status → ccdx image-status |
| CLI-379 | src/doctor.mjs:239 | GitHub token → GitHub token |
| CLI-380 | src/doctor.mjs:239 | Image API key → Image API key |
| CLI-381 | src/doctor.mjs:243 | ${label} file permissions: ${permissions}${permissions === "review" ? " (broader access detected; review manually, no ACL was changed)" : ""} → ${label} file permissions: ${permissions}${permissions === "review" ? " (broader access detected; review manually, no ACL was changed)" : ""} |
| CLI-382 | src/doctor.mjs:255 | Microsoft 365 could not be checked through the running adapter; start ccdx and inspect ccdx m365 status → Microsoft 365 could not be checked through the running adapter; start ccdx and inspect ccdx m365 status |
| CLI-383 | src/doctor.mjs:275 | Adapter ${running.data.version} is listening on ${running.baseUrl} → Adapter ${running.data.version} is listening on ${running.baseUrl} |
| CLI-384 | src/doctor.mjs:277 | Adapter ${running.data?.version &#124;&#124; "legacy"} is running at ${running.baseUrl}, but it is incompatible with this CLI → Adapter ${running.data?.version &#124;&#124; "legacy"} is running at ${running.baseUrl}, but it is incompatible with this CLI |
| CLI-385 | src/doctor.mjs:281 | A service is listening on ${localGatewayBaseUrl(host, port)}, but it is not a compatible codex-copilot-dx adapter → A service is listening on ${localGatewayBaseUrl(host, port)}, but it is not a compatible codex-copilot-dx adapter |
| CLI-386 | src/doctor.mjs:284 | Adapter is not listening on ${localGatewayBaseUrl(host, port)} → Adapter is not listening on ${localGatewayBaseUrl(host, port)} |
| CLI-387 | src/doctor.mjs:285 | ccdx start → ccdx start |
| CLI-388 | src/doctor.mjs:294 | Compatibility checks require a running, version-compatible codex-copilot-dx adapter → Compatibility checks require a running, version-compatible codex-copilot-dx adapter |
| CLI-389 | src/doctor.mjs:316 | ${options.commandName &#124;&#124; "ccdx"} doctor${options.configOnly ? " config" : flags.length ? ` ${flags.join(" ")}` : ""} → ${options.commandName &#124;&#124; "ccdx"} doctor${options.configOnly ? " config" : flags.length ? ` ${flags.join(" ")}` : ""} |
| CLI-390 | src/doctor.mjs:316 |  config →  config |
| CLI-391 | src/doctor.mjs:336 | Summary: ${totals.ok} passed, ${totals.warn} warning(s), ${totals.err} error(s) → Summary: ${totals.ok} passed, ${totals.warn} warning(s), ${totals.err} error(s) |
| CLI-392 | src/doctor.mjs:338 | Next step: ${fix} → Next step: ${fix} |
| CLI-393 | src/launcher.mjs:44 | Unknown macOS prediction App → Unknown macOS prediction App |
| CLI-394 | src/launcher.mjs:73 | Verified Windows browser profile is unavailable; prediction launch was skipped → Verified Windows browser profile is unavailable; prediction launch was skipped |
| CLI-395 | src/launcher.mjs:77 | Existing browser profile override differs from prediction trust; it was preserved → Existing browser profile override differs from prediction trust; it was preserved |
| CLI-396 | src/launcher.mjs:81 | Windows Codex App changed; prediction launch was skipped → Windows Codex App changed; prediction launch was skipped |
| CLI-397 | src/launcher.mjs:86 | Codex already running → Codex already running |
| CLI-398 | src/launcher.mjs:89 | Codex already running → Codex already running |
| CLI-399 | src/launcher.mjs:91 | Running Codex App uses an old or unverified prediction route. Fully quit the App, then run ccdx again; no process was stopped → Running Codex App uses an old or unverified prediction route. Fully quit the App, then run ccdx again; no process was stopped |
| CLI-400 | src/launcher.mjs:102 | Could not launch the registered Windows Codex App → Could not open the registered Codex App |
| CLI-401 | src/launcher.mjs:108 | Codex opened → Codex opened |
| CLI-402 | src/launcher.mjs:109 | Codex launch requested, but the active App did not retain the current prediction route. Core adapter remains available → Codex launch requested, but the active App did not retain the current prediction route. Core adapter remains available |
| CLI-403 | src/launcher.mjs:112 | Optional Windows prediction launch skipped: ${error.message} → Optional Windows prediction launch skipped: ${error.message} |
| CLI-404 | src/launcher.mjs:117 | Automatic launch requires macOS or an enabled Windows prediction setup → Auto-open needs macOS or Windows suggestion setup. |
| CLI-405 | src/launcher.mjs:118 | Open Codex App manually; it will connect to the adapter. → Open Codex App to use this service. |
| CLI-406 | src/launcher.mjs:123 | Auto-launch disabled (CCDX_AUTO_LAUNCH=0); open Codex App manually. → Auto-open is off. Open Codex App manually.<br>CCDX_AUTO_LAUNCH=0 |
| CLI-407 | src/launcher.mjs:135 | Codex already running → Codex already running |
| CLI-408 | src/launcher.mjs:138 | Codex already running → Codex already running |
| CLI-409 | src/launcher.mjs:140 | Running Codex App uses an old or unverified prediction route. Fully quit the App, then run ccdx again; no process was stopped → Running Codex App uses an old or unverified prediction route. Fully quit the App, then run ccdx again; no process was stopped |
| CLI-410 | src/launcher.mjs:144 | Could not launch the verified macOS Codex App → Could not open Codex App |
| CLI-411 | src/launcher.mjs:149 | Codex opened → Codex opened |
| CLI-412 | src/launcher.mjs:154 | Codex launch requested, but the active App did not retain the current prediction route. Core adapter remains available → Codex launch requested, but the active App did not retain the current prediction route. Core adapter remains available |
| CLI-413 | src/launcher.mjs:157 | Optional macOS prediction launch skipped: ${error.message} → Optional macOS prediction launch skipped: ${error.message} |
| CLI-414 | src/launcher.mjs:164 | Codex app launched → Codex opened |
| CLI-415 | src/launcher.mjs:169 | Could not launch the Codex app (checked com.openai.codex, Codex.app, ChatGPT.app) → Could not find or open Codex App.<br>Checked com.openai.codex, Codex.app and ChatGPT.app. |
| CLI-416 | src/launcher.mjs:170 | Open Codex App manually; it will connect to the adapter. → Open Codex App to use this service. |
| CLI-417 | src/launcher.mjs:171 | Download it from https://openai.com/codex → Download it from https://openai.com/codex |
| CLI-418 | src/native-prediction-state.mjs:49 | system HTTPS → system HTTPS |
| CLI-419 | src/native-prediction-state.mjs:49 | system SOCKS → system SOCKS |
| CLI-420 | src/native-prediction-state.mjs:52 | Prediction environment: ${state}; proxy ${source}/${type}; bypass ${count(network?.bypass_rules)} (${count(network?.cidr_rules)} CIDR); extra CA ${ca}; TLS verification required → Prediction environment: ${state}; proxy ${source}/${type}; bypass ${count(network?.bypass_rules)} (${count(network?.cidr_rules)} CIDR); extra CA ${ca}; TLS verification required |
| CLI-421 | src/native-prediction.mjs:19 | Unexpected prediction key directory; it was not changed → Unexpected prediction key directory; it was not changed |
| CLI-422 | src/native-prediction.mjs:38 | Native predictions are off; nothing was enabled or changed. Run ccdx prediction on to opt in. → Input suggestions are off. Nothing changed.<br>To enable: ccdx prediction on |
| CLI-423 | src/native-prediction.mjs:41 | Prediction repair needs a running CCDX adapter with prediction-fix support → Start a CCDX version that supports suggestion repair. |
| CLI-424 | src/native-prediction.mjs:44 | Prediction repair: ${result.status}; bridge: ${prediction.bridge}; candidate: ${prediction.candidate} → Prediction repair: ${result.status}; bridge: ${prediction.bridge}; candidate: ${prediction.candidate} |
| CLI-425 | src/native-prediction.mjs:46 | The running adapter has predictions off; no feature was enabled. → The running adapter has predictions off; no feature was enabled. |
| CLI-426 | src/native-prediction.mjs:47 | Node trust settings changed. Restart the CCDX service to apply them; no certificate or App was changed. → Node trust settings changed. Restart the CCDX service to apply them; no certificate or App was changed. |
| CLI-427 | src/native-prediction.mjs:48 | Network recheck failed; the existing bridge and routes were preserved. ${result.environment_error?.message &#124;&#124; "Check ccdx prediction status."} → Network recheck failed; the existing bridge and routes were preserved. ${result.environment_error?.message &#124;&#124; "Check ccdx prediction status."} |
| CLI-428 | src/native-prediction.mjs:48 | Check ccdx prediction status. → Check ccdx prediction status. |
| CLI-429 | src/native-prediction.mjs:49 | Prediction bridge is unavailable; core service was not changed. → Prediction bridge is unavailable; core service was not changed. |
| CLI-430 | src/native-prediction.mjs:50 | Network settings changed. The bridge uses the new snapshot, but the App may cache its earlier PAC. Fully quit Codex, then run ccdx; no App was restarted. → Network settings changed. The bridge uses the new snapshot, but the App may cache its earlier PAC. Fully quit Codex, then run ccdx; no App was restarted. |
| CLI-431 | src/native-prediction.mjs:51 | App launch route verified. A visible suggestion still needs an App-side check. → App launch route verified. A visible suggestion still needs an App-side check. |
| CLI-432 | src/native-prediction.mjs:52 | Bridge is ready. Run ccdx to open Codex with its prediction route. → Bridge is ready. Run ccdx to open Codex with its prediction route. |
| CLI-433 | src/native-prediction.mjs:53 | Bridge is ready, but App route inspection was unavailable or ambiguous. Check ccdx prediction status; no App was restarted. → Bridge is ready, but App route inspection was unavailable or ambiguous. Check ccdx prediction status; no App was restarted. |
| CLI-434 | src/native-prediction.mjs:54 | Bridge is ready, but the running App route is not verified. No App was restarted. Fully quit Codex, then run ccdx to attach the route. → Bridge is ready, but the running App route is not verified. No App was restarted. Fully quit Codex, then run ccdx to attach the route. |
| CLI-435 | src/native-prediction.mjs:58 | Native prediction preference: ${settings.enabled ? "on" : "off"} (default: off) → Native prediction preference: ${settings.enabled ? "on" : "off"} (default: off) |
| CLI-436 | src/native-prediction.mjs:59 | Prediction configuration adaptation: paused by the WebUI preference; trust and route are retained. → Prediction configuration adaptation: paused by the WebUI preference; trust and route are retained. |
| CLI-437 | src/native-prediction.mjs:60 | Uses the conversation's model. → Uses the conversation's model. |
| CLI-438 | src/native-prediction.mjs:61 | Codex App changed; bridge startup will recheck compatibility. Unsupported changes still require explicit setup. → Codex App changed; bridge startup will recheck compatibility. Unsupported changes still require explicit setup. |
| CLI-439 | src/native-prediction.mjs:66 | Bridge: ${runtime.bridge}; client route: ${runtime.client_route}; visible candidate: ${runtime.candidate} → Bridge: ${runtime.bridge}; client route: ${runtime.client_route}; visible candidate: ${runtime.candidate} |
| CLI-440 | src/native-prediction.mjs:67 | App launch route: ${runtime.launch_route}; persistent route: ${runtime.persistence &#124;&#124; "unknown"} → App launch route: ${runtime.launch_route}; persistent route: ${runtime.persistence &#124;&#124; "unknown"} |
| CLI-441 | src/native-prediction.mjs:68 | Bridge recovery: ${runtime.recovery.recovered} recovered; ${runtime.recovery.attempts}/3 attempts used → Bridge recovery: ${runtime.recovery.recovered} recovered; ${runtime.recovery.attempts}/3 attempts used |
| CLI-442 | src/native-prediction.mjs:71 | ${name}: HTTP ${event.status}${event.modified ? " (local compatibility)" : " (upstream)"} → ${name}: HTTP ${event.status}${event.modified ? " (local compatibility)" : " (upstream)"} |
| CLI-443 | src/native-prediction.mjs:71 |  (local compatibility) →  (local compatibility) |
| CLI-444 | src/native-prediction.mjs:71 |  (upstream) →  (upstream) |
| CLI-445 | src/native-prediction.mjs:72 | Runtime prediction state: unavailable; status is a saved preference, not proof of a visible suggestion. → Runtime prediction state: unavailable; status is a saved preference, not proof of a visible suggestion. |
| CLI-446 | src/native-prediction.mjs:73 | Runtime prediction state: unavailable; start ccdx and check again. → Runtime prediction state: unavailable; start ccdx and check again. |
| CLI-447 | src/native-prediction.mjs:77 | Prediction action must be on, off, status, or fix → Choose prediction on, off, status or fix. |
| CLI-448 | src/native-prediction.mjs:78 | Native prediction setup supports macOS and Windows only; no configuration changed → Native prediction setup supports macOS and Windows only; no configuration changed |
| CLI-449 | src/native-prediction.mjs:88 | Prediction certificate changed; trust cleanup was skipped → Prediction certificate changed; trust cleanup was skipped |
| CLI-450 | src/native-prediction.mjs:91 | Predictions disabled. ${error.message}. Quit Codex and run ccdx prediction off again to finish cleanup. → Predictions disabled. ${error.message}. Quit Codex and run ccdx prediction off again to finish cleanup. |
| CLI-451 | src/native-prediction.mjs:102 | Legacy prediction cleanup skipped: ${error.message} → Legacy prediction cleanup skipped: ${error.message} |
| CLI-452 | src/native-prediction.mjs:103 | Native predictions off. Restart Codex to clear cached predictions and its temporary route. → Native predictions off. Restart Codex to clear cached predictions and its temporary route. |
| CLI-453 | src/native-prediction.mjs:110 | Codex profile changed; disable the previous profile before enabling another → Codex profile changed; disable the previous profile before enabling another |
| CLI-454 | src/native-prediction.mjs:118 | Existing prediction certificate changed; it was preserved → Existing prediction certificate changed; it was preserved |
| CLI-455 | src/native-prediction.mjs:146 | Legacy prediction cleanup skipped: ${error.message} → Legacy prediction cleanup skipped: ${error.message} |
| CLI-456 | src/native-prediction.mjs:148 | Native predictions on. Restart ccdx to launch Codex with the local bridge. → Native predictions on. Restart ccdx to launch Codex with the local bridge. |
| CLI-457 | src/native-prediction.mjs:149 | Only chatgpt.com and ab.chatgpt.com use the App-only route. Their HTTPS traffic is decrypted locally; only prediction configuration is changed. No credentials are stored, no system certificate is installed, and client program files are unchanged. → Only chatgpt.com and ab.chatgpt.com use the App-only route. Their HTTPS traffic is decrypted locally; only prediction configuration is changed. No credentials are stored, no system certificate is installed, and client program files are unchanged. |
| CLI-458 | src/native-prediction.mjs:150 | Existing official prediction configuration is preserved. The conversation's model generates predictions through your configured CCDX API. → Existing official prediction configuration is preserved. The conversation's model generates predictions through your configured CCDX API. |
| CLI-459 | src/native-prediction.mjs:160 | Native predictions were skipped: unsupported platform → Native predictions were skipped: unsupported platform |
| CLI-460 | src/native-prediction.mjs:167 | Saved prediction bridge port is invalid; no route was replaced → Saved prediction bridge port is invalid; no route was replaced |
| CLI-461 | src/native-prediction.mjs:169 | Prediction route changed; automatic recovery was skipped → Prediction route changed; automatic recovery was skipped |
| CLI-462 | src/native-prediction.mjs:174 | Codex App identity/profile changed; run ccdx prediction on after quitting it to recheck compatibility → Codex App identity/profile changed; run ccdx prediction on after quitting it to recheck compatibility |
| CLI-463 | src/native-prediction.mjs:179 | Prediction setup changed during App compatibility recheck → Prediction setup changed during App compatibility recheck |
| CLI-464 | src/native-prediction.mjs:183 | Codex App compatibility rechecked; prediction port and trust were preserved → Codex App compatibility rechecked; prediction port and trust were preserved |
| CLI-465 | src/native-prediction.mjs:186 | Prediction profile trust is unavailable; run ccdx prediction on after quitting Codex → Prediction profile trust is unavailable; run ccdx prediction on after quitting Codex |
| CLI-466 | src/native-prediction.mjs:188 | Prediction certificate changed; setup must be checked again → Prediction certificate changed; setup must be checked again |
| CLI-467 | src/native-prediction.mjs:235 | Prediction setup changed during startup; no saved route was replaced → Prediction setup changed during startup; no saved route was replaced |
| CLI-468 | src/native-prediction.mjs:283 | Prediction route persistence skipped: ${result.reason} → Prediction route persistence skipped: ${result.reason} |
| CLI-469 | src/native-prediction.mjs:287 | Prediction route persistence deferred: ${error.message} → Prediction route persistence deferred: ${error.message} |
| CLI-470 | src/package-update.mjs:19 | "npm.cmd ${args.join(" ")}" → "npm.cmd ${args.join(" ")}" |
| CLI-471 | src/package-update.mjs:79 | Remote download permission must be a boolean → Remote download permission must be a boolean |
| CLI-472 | src/package-update.mjs:81 | Update source must be npm or github: ${source} → Choose npm or github. Received: ${source} |
| CLI-473 | src/package-update.mjs:85 | A valid stable GitHub release tag is required → A valid stable GitHub release tag is required |
| CLI-474 | src/package-update.mjs:107 | npm update was interrupted by ${signal} → npm update was interrupted by ${signal} |
| CLI-475 | src/package-update.mjs:108 | npm update exited with status ${code} → npm update exited with status ${code} |
| CLI-476 | src/package-update.mjs:120 | npm finished, but the target package version could not be verified. Check ccdx doctor; installation was not retried. → npm finished, but the target package version could not be verified. Check ccdx doctor; installation was not retried. |
| CLI-477 | src/package-update.mjs:141 | Remote download permission must be a boolean → Remote download permission must be a boolean |
| CLI-478 | src/package-update.mjs:143 | Update source must be npm or github: ${source} → Choose npm or github. Received: ${source} |
| CLI-479 | src/package-update.mjs:147 | Choose a source with ${commandName} update npm or ${commandName} update github → Choose a source with ${commandName} update npm or ${commandName} update github |
| CLI-480 | src/package-update.mjs:150 | ${commandName} update<br> → ${commandName} update<br> |
| CLI-481 | src/package-update.mjs:151 |   1. npm registry [default]<br> →   1. npm registry [default]<br> |
| CLI-482 | src/package-update.mjs:152 |   2. GitHub release<br> →   2. GitHub release<br> |
| CLI-483 | src/package-update.mjs:161 | Select update source [1], or q to cancel:  → Choose update source [1], or q to cancel:  |
| CLI-484 | src/package-update.mjs:163 | No changes made.<br> → No changes made.<br> |
| CLI-485 | src/package-update.mjs:168 | Enter 1 for npm, 2 for GitHub, or q to cancel.<br> → Enter 1 for npm, 2 for GitHub, or q to cancel.<br> |
| CLI-486 | src/package-update.mjs:177 | Checking the latest stable GitHub release...<br> → Checking the latest stable GitHub release...<br> |
| CLI-487 | src/package-update.mjs:181 | Could not verify npm's remote-download option; no installation was started. Check npm --version and npm config get allow-remote. → Could not verify npm's remote-download option; no installation was started. Check npm --version and npm config get allow-remote. |
| CLI-488 | src/package-update.mjs:185 | Updating ${PACKAGE_NAME} from ${sourceLabel}...<br> → Updating ${PACKAGE_NAME} from ${sourceLabel}...<br> |
| CLI-489 | src/package-update.mjs:186 | npm ${terminalCell(policy.version)}: saved allow-remote=${policy.allowRemote}${policy.registryOrigin ? `; registry ${terminalCell(policy.registryOrigin)}` : ""}.<br> → npm ${terminalCell(policy.version)}: saved allow-remote=${policy.allowRemote}${policy.registryOrigin ? `; registry ${terminalCell(policy.registryOrigin)}` : ""}.<br> |
| CLI-490 | src/package-update.mjs:186 | ; registry ${terminalCell(policy.registryOrigin)} → ; registry ${terminalCell(policy.registryOrigin)} |
| CLI-491 | src/package-update.mjs:187 | Explicit permission for this update only: npm may download URL dependencies throughout the selected package's dependency tree. Registry and persistent npm settings are unchanged.<br> → Explicit permission for this update only: npm may download URL dependencies throughout the selected package's dependency tree. Registry and persistent npm settings are unchanged.<br> |
| CLI-492 | src/package-update.mjs:188 | This npm does not expose the remote-download restriction; no unsupported permission flag was added.<br> → This npm does not expose the remote-download restriction; no unsupported permission flag was added.<br> |
| CLI-493 | src/package-update.mjs:191 | Warning: npm targets ${terminalCell(environment.target)}, not the running package at ${terminalCell(environment.package_root)}. Existing PATH and prefix choices were preserved.<br> → Warning: npm targets ${terminalCell(environment.target)}, not the running package at ${terminalCell(environment.package_root)}. Existing PATH and prefix choices were preserved.<br> |
| CLI-494 | src/package-update.mjs:211 | Updated ${PACKAGE_NAME}: installed v${terminalCell(installedVersion)} at ${terminalCell(environment.target)}.<br> → Updated ${PACKAGE_NAME}: installed v${terminalCell(installedVersion)} at ${terminalCell(environment.target)}.<br> |
| CLI-495 | src/package-update.mjs:216 | Command launcher was preserved; use ccdx.cmd doctor --fix to inspect it. PowerShell policy is unchanged.<br> → Command launcher was preserved; use ccdx.cmd doctor --fix to inspect it. PowerShell policy is unchanged.<br> |
| CLI-496 | src/package-update.mjs:217 | Installed package verified; optional command setup could not finish. Use ccdx.cmd doctor --fix.<br> → Installed package verified; optional command setup could not finish. Use ccdx.cmd doctor --fix.<br> |
| CLI-497 | src/package-update.mjs:220 | Installer finished; the global target was unavailable, so the installed version was not verified. Run ccdx doctor.<br> → Installer finished; the global target was unavailable, so the installed version was not verified. Run ccdx doctor.<br> |
| CLI-498 | src/package-update.mjs:222 | Restart the running adapter to use the installed version; an existing service is not replaced automatically.<br> → Restart the running adapter to use the installed version; an existing service is not replaced automatically.<br> |
| CLI-499 | src/startup-ui.mjs:18 | ${title}<br>Local model services for Codex and Claude → ${title}<br>Local model services for Codex and Claude |
| CLI-500 | src/startup-ui.mjs:19 | by Dale Xiao → by Dale Xiao |
| CLI-501 | src/startup-ui.mjs:19 | Codex + Claude / local services → Codex + Claude / local services |
| CLI-502 | src/startup-ui.mjs:29 | Ready → Ready |
| CLI-503 | src/startup-ui.mjs:29 | Using the existing CCDX adapter → Using the running service |
| CLI-504 | src/startup-ui.mjs:29 | Core service available → Local service ready |
| CLI-505 | src/startup-ui.mjs:30 | Web UI  ${baseUrl} → Web UI  ${baseUrl} |
| CLI-506 | src/startup-ui.mjs:30 | Help    ${commandName} help → Help    ${commandName} help |
| CLI-507 | src/startup-ui.mjs:30 | Stop    Ctrl+C → Stop    Ctrl+C |
| CLI-508 | src/startup-ui.mjs:43 | Prediction → Suggestions |
| CLI-509 | src/startup-ui.mjs:43 | Off → Off |
| CLI-510 | src/startup-ui.mjs:51 | Prediction → Suggestions |
| CLI-511 | src/startup-ui.mjs:52 | Reason → Reason |
| CLI-512 | src/startup-ui.mjs:53 | Details → Details |
| CLI-513 | src/startup-ui.mjs:53 | ccdx prediction status → ccdx prediction status |
| CLI-514 | src/startup-ui.mjs:78 | Providers → Sources |
| CLI-515 | src/startup-ui.mjs:78 | Claude → Claude |
| CLI-516 | src/terminal-console.mjs:44 | Records → Usage records |
| CLI-517 | src/terminal-console.mjs:44 | Input total → Input |
| CLI-518 | src/terminal-console.mjs:44 | Cache read → Reused input |
| CLI-519 | src/terminal-console.mjs:45 | Output → Output |
| CLI-520 | src/terminal-console.mjs:45 | Partial records → Partial usage |
| CLI-521 | src/terminal-console.mjs:46 | HTTP calls → Requests |
| CLI-522 | src/terminal-console.mjs:46 | Active → Active |
| CLI-523 | src/terminal-console.mjs:46 | Completed → Completed |
| CLI-524 | src/terminal-console.mjs:46 | Incomplete → Incomplete |
| CLI-525 | src/terminal-console.mjs:46 | Failed → Failed |
| CLI-526 | src/terminal-console.mjs:46 | Cancelled → Cancelled |
| CLI-527 | src/terminal-console.mjs:71 | CCDX RUNNING / uptime ${Math.floor((data.uptime_ms &#124;&#124; 0) / 60000)}m / ${baseUrl} → CCDX RUNNING / uptime ${Math.floor((data.uptime_ms &#124;&#124; 0) / 60000)}m / ${baseUrl} |
| CLI-528 | src/terminal-console.mjs:72 | Providers / ${providers.catalogs} → Sources / ${providers.catalogs} |
| CLI-529 | src/terminal-console.mjs:72 | Claude / ${providers.claude} → Claude / ${providers.claude} |

动态状态补充：

| 原文案或行为 | 新文案或行为 |
| --- | --- |
| restored 被显示为 not checked | settings restored |
| Running; App route verified; suggestion unchecked | Running; suggestion display not verified |
| 读取失败时继续显示旧数据，没有标记 | Showing previous data / updated HH:MM:SS；窄终端 Previous data / HH:MM:SS |
| 窄终端截掉来源和 Claude 状态 | 按宽度换行；40×16 使用紧凑表格，保留用量、来源、Code/App 状态 |
| 混合来源的相同模型结果 | ccdx status 按 source / protocol 分列结果 |

## 1.2.3 公司账号补充

CLI 仍保持英文；原始错误码保留在诊断中。新增账号命令与 `m365 help` 一致。

| 原文案或状态 → 新文案 | 行为 |
| --- | --- |
| `Microsoft 365 unavailable: m365_account_ambiguous` → `Choose a company account in Model sources or run ccdx m365 account.` | 明确选择入口，不申请其他账号令牌 |
| 无账号列表 → `ccdx m365 accounts` | 只做本地发现，列出邮箱、租户、选择标识 |
| 无账号选择 → `Choose an account, or q to cancel:` | 选择后验证该账号，取消不改变绑定 |
| 无切换范围提示 → `Applies to Microsoft 365 in Codex and Claude. Use a new conversation after changing accounts.` | 切换前说明影响 |
| 无跨账号历史提示 → `This conversation belongs to another company account. Start a new conversation.` | 拒绝跨账号转发历史 |

## 1.2.8 增量

| 原文案 → 新文案 | 含义 |
| --- | --- |
| 用量表原有空行 → Cache hit | 本次运行复用输入 ÷ 输入 Token |
| 无新增中文 CLI 文案 | CLI 继续英文 |

百分比使用原始聚合值，与 Overview 同口径；不完整缓存证据加 `~`，未知或无效显示 `—`。淡粉主题保留全部既有状态标签和布局。
# 1.2.30 update-path additions

These rows supersede older update-help wording in the historical comparison.

| Previous copy | Current copy |
|---|---|
| Failed installations are not retried automatically. | GitHub updates retry once offline with a verified same-version platform package only after EALLOWREMOTE; other errors are not retried. |
| npm error code EALLOWREMOTE | npm refused a remote dependency. Previous installation restored; checking the same version's complete platform package. |
| Dependencies use the configured npm registry. | Complete platform package verified; installing offline with the saved npm policy. |


# 1.2.31 presentation boundary

CLI commands and normal terminal output are unchanged. Display names do not change model IDs accepted by CLI tools. The new model.error diagnostic event preserves HTTP status and structured upstream error identifiers; it does not add scrolling request logs or automatic inference retries.
