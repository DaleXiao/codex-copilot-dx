# WebUI 文案对照

此表保留历史文案对照，不作为当前功能说明。当前行为以 README 和 REFERENCE 为准；1.2.3 公司账号、1.2.4 版本信息和 1.2.5 用量图表和 1.2.6 网络诊断增量见文末。

基线：1.1.1。现文案：1.2.0。固定消息标识见 `src/dashboard/language.js`；中文和英文分别展示。保留产品名、模型 ID、命令、单位与错误码。动态原始数据不翻译、不截短来满足文案长度。

| 固定标识 | 原英文 → 新英文 | 原中文 → 新中文 |
| --- | --- | --- |
| codex_body_admission_active_active_queued_queued_queue_limit_lim | Codex body admission: active {active} / queued {queued} / queue limit {limit} → Codex body admission: active {active} / queued {queued} / queue limit {limit} | Codex请求体：进行中{active}<br>排队{queued} / 队列上限{limit} → Codex请求体：进行中{active}<br>排队{queued} / 队列上限{limit} |
| terminal_animation_unavailable_in_this_output_mode | Terminal animation unavailable in this output mode → Terminal animation unavailable in this output mode | 当前输出模式不播放终端动效 → 当前输出模式不播放终端动效 |
| prediction_integration_setup | Prediction integration setup → Suggestion setup | 预测集成配置 → 建议设置 |
| visible_status_updates_every_2_seconds_catalogs_and_retained_usa | Visible status updates every 2 seconds. Catalogs and retained usage refresh on demand or every 30 minutes while open. → Visible status updates every 2 seconds. Catalogs and retained usage refresh on demand or every 30 minutes while open. | 可见状态每2秒更新。<br>目录和留存用量按需更新，<br>展开时每30分钟刷新。 → 可见状态每2秒更新。<br>列表和留存用量按需更新，<br>展开时每30分钟刷新。 |
| clients | Clients → Apps | 客户端 → 应用 |
| model_services | Model services → Model sources | 模型服务 → 模型来源 |
| usage_and_diagnostics | Usage and diagnostics → Usage and issues | 用量与诊断 → 用量排查 |
| system_and_settings | System and settings → Settings | 系统与设置 → 设置 |
| main_navigation | Main navigation → Navigation | 主导航 → 页面导航 |
| local_control | LOCAL CONTROL → LOCAL CONTROL | 本机控制台 → 本机控制 |
| terminal_appearance | Terminal appearance → Terminal appearance | 终端外观 → 终端外观 |
| local_service_client_specific_capabilities_stay_with_their_clien | Local service. Client-specific capabilities stay with their client. → Runs on this computer. Each app has its own features. | 本机服务；专属能力归属各自客户端。 → 在本机运行。<br>各应用功能分别列出。 |
| configuration_observation | CONFIGURATION + OBSERVATION → SETUP AND ACTIVITY | 配置与观察 → 接入状态 |
| codex_conversations | CODEX CONVERSATIONS → CODEX CONVERSATIONS | Codex 对话与暂存 → 对话处理 |
| codex_conversation_buffer | CODEX CONVERSATION BUFFER → CONVERSATION BUFFER | Codex 对话暂存 → 对话暂存 |
| codex_input_predictions | CODEX INPUT PREDICTIONS → INPUT SUGGESTIONS | Codex 输入预测 → 输入建议 |
| codex_only | CODEX ONLY → CODEX ONLY | Codex 专属 → Codex 专属 |
| codex_image_generation | CODEX IMAGE GENERATION → IMAGE GENERATION | Codex 图片生成 → 图片生成 |
| image_service | Image service → Image service | 生图服务 → 图片服务 |
| allow_new_image_calls | Allow new image calls → Allow image requests | 允许新的生图调用 → 图片生成 |
| allow_prediction_configuration | Allow prediction configuration → Allow suggestion updates | 允许预测配置适配 → 建议更新 |
| check_and_repair | Check and repair → Check and repair | 检查并修复 → 检查修复 |
| temporary_local_data_for_responses_continuation_not_a_conversati | Temporary local data for Responses continuation, not a conversation archive. → Keeps temporary data to continue replies. Does not save a chat archive. | 用于 Responses 对话续接的本机<br>临时数据，并非聊天归档。 → 临时保留续聊数据。<br>不作为聊天归档。 |
| buffer_limit_mib | Buffer limit MiB → Buffer limit (MiB) | 暂存上限 MiB → 暂存上限 MiB |
| apply_limit | Apply limit → Save limit | 应用上限 → 保存上限 |
| clear_inactive_buffer | Clear inactive buffer → Clear conversation buffer | 清理未使用暂存 → 清空暂存 |
| pause_keeps_the_provider_configuration_running_calls_can_finish_ | Pause keeps the provider configuration. Running calls can finish. First-time setup: ccdx enable-image. → Pause keeps your setup. Running image requests can finish. First setup: ccdx enable-image. | 暂停保留 Provider 配置，进行中<br>的调用可以完成。首次配置：ccdx<br>enable-image。 → 暂停后保留图片设置。<br>已开始的生成可继续完成。<br>首次设置：<br>ccdx enable-image |
| pause_keeps_the_existing_trust_and_route_codex_may_retain_cached | Pause keeps the existing trust and route. Codex may retain cached suggestions. First-time setup: quit Codex, then ccdx prediction on. → Pause keeps existing trust and routing. Cached suggestions may still appear. First quit Codex, then run ccdx prediction on. | 暂停保留已有信任和路由，Codex 可能<br>保留已缓存的建议。首次配置：退出<br>Codex 后执行 ccdx<br>prediction on。 → 暂停后保留信任与连接设置。<br>已有建议可能仍会显示。<br>首次设置前请退出 Codex。<br>ccdx prediction on |
| service_settings | SERVICE SETTINGS → SERVICE SETTINGS | 服务设置 → 服务设置 |
| saved_preference_and_effective_state_are_separate_environment_ov | Saved preference and effective state are separate. Environment overrides and client restarts are shown explicitly. → Saved choices and current behavior are shown separately. Startup overrides and required restarts are listed. | 保存的偏好与实际生效状态分别显示；环境覆<br>盖和客户端重启要求会明确标注。 → 已保存与已生效分别显示。<br>启动限制与重启要求会注明。 |
| terminal_animation | Terminal animation → Terminal animation | 终端动效 → 终端动效 |
| open_webui_at_startup | Open WebUI at startup → Open dashboard on startup | 启动时打开 WebUI → 启动打开 |
| reading_settings | Reading settings… → Reading settings… | 正在读取设置… → 读取设置中… |
| codex_model_source | CODEX MODEL SOURCE → CODEX MODEL SOURCE | Codex 模型来源 → 模型来源 |
| catalog_tabs_only_change_the_view_apply_explicitly_to_change_the | Catalog tabs only change the view. Apply explicitly to change the source for future Codex requests. → Tabs only browse models. Apply changes the source for later Codex requests. | 目录标签仅切换查看对象。点击应用才会改变<br>后续 Codex 请求的来源。 → 切换标签只查看模型。<br>保存后更改后续请求的来源。 |
| auto_review_model | Auto-review model → Review model | 自动审查模型 → 审查模型 |
| apply_source | Apply source → Use this source | 应用来源 → 使用来源 |
| enable_service | Enable service → Enable source | 启用服务 → 开启接入 |
| disable_service | Disable service → Disable source | 停用服务 → 停用接入 |
| since_this_service_started_configuration_authorization_model_dis | Since this service started. Configuration, authorization, model discovery and successful inference are separate evidence. → Counts start with this service. Setup, sign-in, listed models and successful requests are separate checks. | 自本次服务启动起统计。配置、授权、模型发<br>现和成功推理是不同证据。 → 从本次启动开始统计。<br>设置、登录、模型列表分别核实。<br>请求成功情况单独记录。 |
| process_listener | PROCESS + LISTENER → LOCAL SERVICE | 进程与监听器 → 本机服务 |
| http_traffic | HTTP TRAFFIC → SERVICE REQUESTS | 主入口 HTTP 流量 → 服务请求 |
| this_run_usage | THIS RUN USAGE → THIS RUN | 本次运行用量 → 本次用量 |
| updated_from_returned_usage_not_a_live_bill_pending_usage_is_not | Updated from returned usage, not a live bill. Pending usage is not included. → Counts returned usage only. Pending usage is not included. This is not a live bill. | 根据已返回的用量更新，不代表实时账单；尚<br>未返回的用量不计入。 → 仅统计已返回的用量。<br>不含尚未返回的数据。<br>不代表实时账单。 |
| applies_to_the_running_terminal | Applies to the running terminal. → Updates the running terminal. | 应用到运行中的终端。 → 保存后更新当前终端。 |
| recent_inference_http_failures | RECENT INFERENCE + HTTP FAILURES → RECENT REQUEST ISSUES | 近期推理与 HTTP 故障 → 近期异常 |
| codex_responses_timing_since_startup_output_speed_is_estimated | Codex Responses timing since startup. Output speed is estimated. → Codex Responses timing since startup. Speed is estimated. | 自启动起的 Codex<br>Responses 时序；输出速度为估计<br>值。 → 记录本次 Codex 耗时。<br>输出速度为估计值。 |
| service_reachable | SERVICE REACHABLE → CONNECTED LOCALLY | 服务可访问 → 已连本机 |
| saved_choice_applies_to_the_running_terminal | Saved choice applies to the running terminal. → Saving updates the running terminal. | 保存后应用到运行中的终端。 → 保存后更新当前终端。 |
| effective_now | Effective now → Active now | 即时生效 → 已生效 |
| next_ccdx_start | Next CCDX start → Next CCDX start | 下次启动 CCDX 生效 → 重启 CCDX 后生效 |
| applies_to_new_calls | Applies to new calls → New requests only | 对后续调用生效 → 后续生效 |
| setup_required | Setup required → Setup needed | 需要先配置 → 尚未设置 |
| next_configuration_request_cached_suggestions_may_remain | Next configuration request; cached suggestions may remain → Applies on the next settings request. Cached suggestions may still appear. | 对后续配置请求生效；已缓存建议可能仍存在 → 下次读取建议设置时生效。<br>已有建议可能仍会显示。 |
| reopen_the_client_to_finish | Reopen the client to finish → Reopen the app | 需要重新打开客户端 → 重开应用 |
| restart_ccdx_to_finish | Restart CCDX to finish → Restart CCDX | 需要重启 CCDX → 请重启 CCDX |
| saved_saved_effective_effective_state | Saved {saved} / effective {effective} / {state} → Saved: {saved}<br>Active: {effective}<br>{state} | 保存：{saved} / 实际：{effective} / {state} → 已保存：{saved}<br>已生效：{effective}<br>{state} |
| on | On → On | 开启 → 开启 |
| off | Off → Off | 关闭 → 关闭 |
| controlled_by_environment | Controlled by environment → Set at startup | 由环境变量控制 → 启动限定 |
| settings_read_from_the_running_service | Settings read from the running service. → Settings loaded from the running service. | 已读取运行中服务的设置。 → 已读取当前服务设置。 |
| applying | Applying… → Applying… | 正在应用… → 正在应用… |
| clear_inactive_codex_conversation_data_older_continuation_ids_ma | Clear inactive Codex conversation data? Older continuation IDs may stop working. → Clear the conversation buffer for all chats?<br>Older chats may not continue.<br>Saved Codex transcripts are kept. | 清理未使用的 Codex 对话暂存？旧的<br>续接 ID 可能失效。 → 清空全部对话暂存？<br>旧对话可能无法继续。<br>Codex 已保存的记录仍保留。 |
| records_usage_records_input_input_cache_read_cached_output_outpu | {records} usage records / input {input} / cache read {cached} / output {output}{partial} → {records} usage records<br>Input: {input} / reused: {cached}<br>Output: {output}{partial} | {records} 条用量记录 / 输入 {input} / 缓存读取 {cached}<br> / 输出 {output}{partial} → 用量记录：{records}<br>输入：{input}／复用：{cached}<br>输出：{output}{partial} |
| rss_rss_heap_heap | RSS {rss} / heap {heap} → RSS {rss} / heap {heap} | 常驻内存 {rss} / 堆内存 {heap} → 常驻内存 {rss} / 堆内存 {heap} |
| codex_models | CODEX MODELS → CODEX MODELS | Codex 模型 → 模型列表 |
| codex_requests | CODEX REQUESTS → CODEX REQUESTS | Codex 请求 → Codex 请求 |
| state_reason | {state} / {reason} → {state} / {reason} | {state} / {reason} → {state} / {reason} |
| runtime_resources | RUNTIME RESOURCES → CURRENT RESOURCES | 运行资源 → 资源用量 |
| additional_capabilities | ADDITIONAL CAPABILITIES → MORE FEATURES | 附加能力 → 更多功能 |
| sources | SOURCES → SOURCES | 模型来源 → 模型来源 |
| account_authorization | ACCOUNT AUTHORIZATION → ACCOUNT AUTHORIZATION | 账号授权 → 账号授权 |
| by_provider | BY PROVIDER → BY SOURCE | 按来源列出 → 按来源 |
| account | ACCOUNT → ACCOUNT | 账号 → 账号 |
| authorization | AUTHORIZATION → AUTHORIZATION | 授权状态 → 授权状态 |
| service | SERVICE → SERVICE | 服务状态 → 服务状态 |
| last_verified | LAST VERIFIED → LAST VERIFIED | 最近验证 → 最近验证 |
| client | CLIENT → APP | 客户端 → 使用应用 |
| state | STATE → STATE | 状态 → 状态 |
| gateway | GATEWAY → LOCAL ACCESS | 网关 → 本机接入 |
| last_request | LAST REQUEST → LAST REQUEST | 最近请求 → 最近请求 |
| client_connections | CLIENT CONNECTIONS → APP SETUP | 客户端接入 → 应用接入 |
| model_catalog | MODEL CATALOG → MODEL LIST | 模型目录 → 模型列表 |
| reasoning | REASONING → THINKING LEVEL | 推理档位 → 思考强度 |
| model_providers | Model providers → Model providers | 模型来源 → 模型来源 |
| reading_provider_catalog | Reading provider catalog… → Loading model list… | 正在读取模型目录… → 读取模型中… |
| no_models_advertised | No models advertised. → No models listed. | 目录未返回模型。 → 暂未列出模型。 |
| no_catalog_available | No catalog available. → Model list unavailable. | 模型目录不可用。 → 暂时无法读取模型列表。 |
| saved_locally | Saved locally → Sign-in saved | 本机已保存 → 登录已存 |
| authorized | Authorized → Authorized | 已授权 → 已授权 |
| ready | Ready → Ready | 就绪 → 已就绪 |
| checking | Checking → Checking | 检查中 → 检查中 |
| unsupported | Unsupported → Not supported here | 当前平台不支持 → 暂不支持 |
| standby | Standby → Not selected | 备用未启用 → 暂未使用 |
| listed | Listed → In model list | 目录已列出 → 已列出 |
| restricted | Restricted → Restricted | 受限制 → 受限制 |
| hidden | Hidden upstream → Hidden by source | 上游已隐藏 → 来源隐藏 |
| running | Running → Running | 运行中 → 运行中 |
| unavailable | Unavailable → Unavailable | 不可用 → 不可用 |
| count_providers | {count} providers → {count} providers | {count}个来源 → {count}个来源 |
| provider_done_done_incomplete_incomplete_failed_failed | {provider}: {done} done / {incomplete} incomplete / {failed} failed → {provider}: {done} done / {incomplete} incomplete / {failed} failed | {provider}：完成{done}·未完成{incomplete}·失败{failed} → {provider}：完成{done}·未完成{incomplete}·失败{failed} |
| provider_status_authorization_and_inference_are_separate | Provider status / authorization and inference are separate. → Source status. Sign-in and successful requests are checked separately. | 来源状态。<br>授权与推理分别验证。 → 来源状态分别核实。<br>登录不代表请求一定成功。 |
| saved_credentials_authorization_model_access_and_client_requests | Saved credentials, authorization, model access and client requests are separate evidence. → Saved sign-in, access, models and app requests are separate checks. | 凭据、授权、模型访问<br>和客户端请求分别验证。 → 登录信息、访问权限分别核实。<br>模型访问与应用请求单独记录。 |
| client_features | CLIENT FEATURES → APP FEATURES | 接入能力 → 应用功能 |
| observed_state | OBSERVED STATE → LAST OBSERVED | 实际状态 → 最近记录 |
| native_predictions | Native predictions → Input suggestions | 输入建议 → 输入建议 |
| local_bridge | Local bridge → Local service | 本地接入 → 本机服务 |
| client_route | Client route → App settings requests | 配置请求 → 应用请求 |
| visible_candidate | Visible candidate → Suggestion displayed | 显示结果 → 建议显示 |
| configured_does_not_mean_displayed_use_ccdx_prediction_status_fo | Enabled is not proof of a visible suggestion. Check ccdx prediction status. → Enabled does not mean a suggestion appeared. Details: ccdx prediction status. | 开启不等于已显示。<br>终端命令可查看详情。 → 开启不代表建议已显示。<br>ccdx prediction status |
| enabled | Enabled → Enabled | 已开启 → 已开启 |
| disabled | Disabled → Disabled | 已关闭 → 已关闭 |
| running_f4cca | Running → Running | 运行中 → 运行中 |
| recovering | Recovering → Recovering | 恢复中 → 恢复中 |
| stopped | Stopped → Stopped | 未运行 → 未运行 |
| unavailable_ca184 | Unavailable → Unavailable | 不可用 → 不可用 |
| observed | Observed → Settings request received | 已收到配置请求 → 已收到 |
| first_output | First output → First output | 首次输出 → 首个输出 |
| output_speed | Output speed → Output speed | 输出速度 → 输出速度 |
| inference_inference_method_protocol_route_route_other_other | Inference {inference} / method {protocol} / route {route} / other {other} → Model: {inference} / method: {protocol}<br>Path: {route} / other: {other} | 推理{inference}·方法{protocol}·路由{route}·其他{other} → 模型：{inference}／方式：{protocol}<br>入口：{route}／其他：{other} |
| upstream_returned_no_error_details | The upstream returned no error details. → The model service gave no error details. | 上游未返回错误详情。 → 模型来源未返回错误详情。 |
| error_type | Error type → Error type | 错误类型 → 错误类型 |
| parameter | Parameter → Parameter | 请求参数 → 请求参数 |
| error_body | Error details → Error details | 错误详情 → 错误详情 |
| diagnostic_message | Opt-in error detail → Extra error details | 诊断详情 → 更多详情 |
| method | Method → Method | 请求方法 → 请求方法 |
| target | Endpoint → Service address | 请求入口 → 服务地址 |
| request_options | Request options → Request options | 请求选项 → 请求选项 |
| requested_model | Requested model → Requested model | 指定模型 → 指定模型 |
| request_kind | Request purpose → Request purpose | 请求用途 → 请求用途 |
| attempt_timings | Upstream attempts → Send attempts | 上游尝试 → 发送次数 |
| gateway_timing_output_speed_is_estimated | Gateway estimates, not internal model timing or total throughput. → Estimated by CCDX. Not internal model time or total throughput. | 网关估算值。<br>非模型内部耗时或总吞吐量。 → 由 CCDX 估算。<br>不代表模型内部耗时或总吞吐。 |
| value_samples_samples | {value} / {samples} samples → {value} / {samples} samples | {value} / {samples}次样本 → {value} / {samples}次样本 |
| ccdx_local_dashboard | CCDX · Dashboard → CCDX · Dashboard | CCDX · 运行看板 → CCDX · 运行面板 |
| local_status | / DASHBOARD → / DASHBOARD | / 运行看板 → / 运行面板 |
| reading | READING → READING | 读取中 → 读取中 |
| local_ok | LOCAL OK → CONNECTED LOCALLY | 本机正常 → 已连本机 |
| unavailable_eb0be | UNAVAILABLE → UNAVAILABLE | 无法读取 → 无法读取 |
| refresh | Refresh → Refresh | 刷新 → 刷新 |
| auto_refresh | Auto refresh → Auto refresh | 自动更新 → 自动更新 |
| auto_refresh_on | Auto refresh · ON → Auto refresh · ON | 自动更新 · 开 → 自动更新 · 开 |
| auto_refresh_off | Auto refresh · OFF → Auto refresh · OFF | 自动更新 · 关 → 自动更新 · 关 |
| every_30_minutes_while_visible_open_sections_update_on_demand | Every 30 minutes while visible. Opening a section updates it. → Refreshes every 30 minutes while visible. Opening a section also refreshes it. | 可见时每30分钟更新。<br>展开区域也会更新。 → 可见时每30分钟刷新。<br>展开栏目也会刷新。 |
| local_only_visible_page_updates | LOCAL ONLY / UPDATES WHILE VISIBLE → THIS COMPUTER ONLY / UPDATES WHILE VISIBLE | 仅限本机 / 页面可见时更新 → 仅限本机／页面可见时更新 |
| updated_time | Updated {time} → Updated {time} | 更新于{time} → 更新于{time} |
| saved_account_updated_time | Saved account only / updated {time} → Saved account only / updated {time} | 本机保存账号 / 更新于{time} → 本机保存账号 / 更新于{time} |
| update_failed_last_time | Update failed / last {time} → Update failed / last {time} | 更新失败 / 上次{time} → 更新失败 / 上次{time} |
| update_failed | Update failed → Update failed | 更新失败 → 更新失败 |
| github_account_update_failed | GitHub / {account} / UPDATE FAILED → GitHub / {account} / UPDATE FAILED | GitHub / {account} / 更新失败 → GitHub / {account} / 更新失败 |
| animation | Animation → Animation | 动效 → 动效 |
| switch_to_light_mode | Light mode → Light mode | 白天模式 → 浅色模式 |
| switch_to_dark_mode | Dark mode → Dark mode | 夜间模式 → 深色模式 |
| overview | Overview → Overview | 概览 → 概览 |
| recent_request_context | RECENT REQUESTS → RECENT REQUESTS | 近期请求 → 近期请求 |
| wire_mib | DATA SIZE → DATA SIZE | 数据大小 → 数据大小 |
| images | IMAGES → IMAGES | 图片数量 → 图片数量 |
| input_tokens | INPUT USAGE → INPUT USAGE | 输入用量 → 输入用量 |
| model_window | MODEL CAPACITY → MODEL LIMIT | 模型容量 → 模型上限 |
| input_window | CAPACITY USED → CAPACITY USED | 占用比例 → 占用比例 |
| outcome | RESULT → RESULT | 结果 → 结果 |
| unknown | Unknown → Unknown | 未知 → 未知状态 |
| no_observed_request_metadata | No request records yet. → No request records yet. | 暂未收到请求记录。 → 暂未收到请求记录。 |
| 20_latest_finished_requests_compactions_completed_completed_inco | Last 20 finished requests.<br>History compaction: {completed} completed · {incomplete} incomplete · {failed} failed → Last 20 finished requests.<br>History compaction: {completed} completed · {incomplete} incomplete · {failed} failed | 最近20次已结束请求。<br>压缩完成：{completed}次<br>压缩未完成：{incomplete}次<br>压缩失败：{failed}次 → 最近20次已结束请求。<br>压缩完成：{completed}次<br>压缩未完成：{incomplete}次<br>压缩失败：{failed}次 |
| recent_upstream_request_metadata_not_exact_live_session_occupanc | Size: MiB. Usage and capacity: Token.<br>Request records, not exact current thread usage.<br>Missing data is unknown. No prompts or images are saved. → Size: MiB. Usage: Token.<br>Request records do not show exact current-chat usage.<br>Missing data is unknown. This panel keeps no prompts or images. | 大小单位：MiB。<br>用量单位：Token。<br>不是会话当前的精确占用。<br>缺失数据表示未知。<br>不保存提问或图片内容。 → 大小单位：MiB。<br>用量单位：Token。<br>不代表当前对话的精确占用。<br>缺失数据表示未知。<br>此面板不保存提问或图片。 |
| runtime_details | Runtime details → Runtime details | 运行详情 → 运行详情 |
| adapter | SERVICE → SERVICE | 服务状态 → 服务状态 |
| known_models | MODEL COUNT → MODEL COUNT | 模型数量 → 模型数量 |
| requests | REQUESTS → REQUESTS | 请求次数 → 请求次数 |
| per_request_limits_active | Per-request limits → Per-request limits | 单次上限 → 单次上限 |
| model_outcomes | REQUEST RESULTS → REQUEST RESULTS | 处理结果 → 处理结果 |
| completed | Completed → Completed | 已完成 → 已完成 |
| incomplete | Incomplete → Incomplete | 未完成 → 未完成 |
| failed | Failed → Failed | 失败 → 失败 |
| cancelled | Cancelled → Cancelled | 已取消 → 已取消 |
| http_2xx_model_completed | HTTP 2xx can still mean an unfinished reply. → HTTP success does not mean a complete reply. | HTTP 2xx也可能没答完整。 → 请求成功不代表回复完整。 |
| local_history | LOCAL HISTORY → LOCAL HISTORY | 对话暂存 → 对话暂存 |
| active_limit | STORAGE LIMIT → STORAGE LIMIT | 存储上限 → 暂存上限 |
| history_cache_usage | Local history usage → Local history usage | 对话暂存 → 对话暂存 |
| image_generation | IMAGE GENERATION → IMAGE GENERATION | 图片生成 → 图片生成 |
| optional | OPT-IN → OPT-IN | 按需开启 → 按需开启 |
| separate_profile | SEPARATE PROFILE → SEPARATE SIGN-IN | 独立授权 → 独立登录 |
| source | Source → Source | 来源 → 来源 |
| provider | Source → Source | 来源 → 来源 |
| catalog_snapshot | SAVED CATALOG → SAVED MODEL LIST | 目录快照 → 已存列表 |
| all_providers | All providers → All providers | 全部来源 → 全部来源 |
| m365_ready | AUTHORIZED → AUTHORIZED | 已授权 → 已授权 |
| m365_checking | CHECKING → CHECKING | 检查中 → 检查中 |
| m365_off | OFF → OFF | 已关闭 → 已关闭 |
| m365_unsupported | NOT SUPPORTED → NOT SUPPORTED | 暂不支持 → 暂不支持 |
| m365_unavailable | UNAVAILABLE → UNAVAILABLE | 未接入 → 未接入 |
| m365_unknown | UNKNOWN → UNKNOWN | 未知 → 未知 |
| account_unavailable | Account unavailable → Account unavailable | 暂无账号信息 → 账号未知 |
| claude_claude_gpt_gpt | Claude {claude} / GPT {gpt} → Claude {claude} / GPT {gpt} | Claude {claude}个 / GPT {gpt}个 → Claude {claude}个 / GPT {gpt}个 |
| claude_gateway_running | Claude gateway running → Claude local service running | Claude 网关已运行 → Claude 本机服务已运行 |
| claude_gateway_unavailable | Claude gateway unavailable → Claude local service unavailable | Claude 网关未运行 → Claude 本机服务不可用 |
| claude_done_done_incomplete_incomplete_failed_failed | Claude: {done} done / {incomplete} incomplete / {failed} failed → Claude: {done} done / {incomplete} incomplete / {failed} failed | 完成 {done} / 未完成 {incomplete} / 失败 {failed} → 完成 {done} / 未完成 {incomplete} / 失败 {failed} |
| claude_requests_unavailable | Claude requests unavailable → No Claude request data | 暂无请求数据 → 暂无 Claude 请求数据 |
| code_code_app_app | Code: {code}<br>App: {app} → Code: {code}<br>App: {app} | Code：{code}<br>App：{app} → Code：{code}<br>App：{app} |
| configured | Configured → Configured | 已配置 → 已配置 |
| existing_settings_kept | Existing settings kept → Custom settings kept | 保留原配置 → 原样保留 |
| restored | Restored → Restored | 已恢复 → 已恢复 |
| not_installed | Not installed → Not installed | 未安装 → 未安装 |
| setup_unavailable | Setup unavailable → Could not configure | 配置失败 → 设置失败 |
| not_configured | Not configured → Not configured | 未配置 → 未配置 |
| codex_source_microsoft_365 | Codex source: Microsoft 365 → Codex source: Microsoft 365 | Codex：M365 → Codex：M365 |
| codex_source_github_copilot | Codex source: GitHub Copilot → Codex source: GitHub Copilot | Codex：GitHub Copilot → Codex：GitHub Copilot |
| live_upstream_models | Online models → Latest model list | 在线模型 → 最新列表 |
| upstream_gpt_models | ONLINE MODELS → LATEST MODEL LIST | 在线模型 → 最新列表 |
| checking_live | CHECKING → CHECKING | 查询中 → 查询中 |
| querying_github_copilot | Checking Copilot models… → Checking Copilot models… | 正在查询Copilot模型。 → 查询 Copilot 模型中… |
| model | MODEL → MODEL | 模型 → 模型 |
| vendor | PROVIDER → MODEL MAKER | 提供方 → 模型厂商 |
| api | INTERFACE → CONNECTION TYPE | 连接方式 → 连接方式 |
| flag | STAGE → STAGE | 阶段 → 阶段 |
| loading | Loading… → Loading… | 加载中 → 加载中 |
| catalog_listing_does_not_guarantee_inference_access | A listed model may still be unavailable to your account. → Listed does not mean your account can use it. | 模型列出后，仍可能无法使用。 → 列出不代表账号可使用。 |
| usage_by_model | Model usage → Model usage | 模型用量 → 模型用量 |
| usage | MODEL USAGE → MODEL USAGE | 模型用量 → 模型用量 |
| reading_log | COUNTING → COUNTING | 统计中 → 统计中 |
| all_history | Show all → Show all | 查看全部 → 查看全部 |
| aggregating_local_usage_metadata | Counting local usage… → Counting local usage… | 正在统计本机用量。 → 正在统计本机用量。 |
| calls | REQUESTS → REQUESTS | 请求次数 → 请求次数 |
| input | INPUT USAGE → INPUT USAGE | 输入用量 → 输入用量 |
| cache_read | REUSED INPUT → REUSED INPUT | 重用输入 → 复用输入 |
| output | OUTPUT USAGE → OUTPUT USAGE | 输出用量 → 输出用量 |
| total | TOTAL → TOTAL | 总用量 → 总用量 |
| cache_hit | REUSE RATE → REUSE RATE | 重用比例 → 复用比例 |
| cache_hit_recorded_cached_input_tokens_incomplete_history_unavai | Usage unit: Token. Reuse rate = reused input / input usage.<br>~ means incomplete records. — means unknown or invalid data. → Unit: Token. Reused input is part of input.<br>~ Partial records. — Unknown or invalid. | 用量单位：Token。<br>重用输入占输入用量的比例。<br>~：记录不完整。<br>—：数据未知或无效。 → 用量单位：Token。<br>复用部分已计入输入。<br>~：记录不完整。<br>—：数据未知或无效。 |
| usage_analytics | USAGE TRENDS → USAGE TRENDS | 用量趋势 → 用量趋势 |
| model_5e2c6 | Model → Model | 模型 → 模型 |
| all_models | All models → All models | 全部模型 → 全部模型 |
| daily_range | Date range → Date range | 时间范围 → 时间范围 |
| 7_days | Last 7 days → Last 7 days | 近7天 → 近7天 |
| 30_days | Last 30 days → Last 30 days | 近30天 → 近30天 |
| 90_days | Last 90 days → Last 90 days | 近90天 → 近90天 |
| activity | Measure → Measure | 统计内容 → 统计内容 |
| calls_b73a5 | Requests → Requests | 请求次数 → 请求次数 |
| tokens | Usage (Token) → Usage (Token) | 处理用量 → 处理用量 |
| open_to_read_retained_usage_history | Open to view usage trends. → Open to view usage trends. | 展开查看用量趋势。 → 展开查看用量趋势。 |
| daily_tokens | DAILY USAGE → DAILY USAGE | 每日用量 → 每日用量 |
| input_output_cache_included_in_input | INPUT + OUTPUT · REUSED INPUT INCLUDED → INPUT + OUTPUT / REUSED INPUT IS PART OF INPUT | 输入与输出合计。<br>重用部分已计入输入用量。 → 输入与输出合计。<br>复用部分已计入输入。 |
| daily_token_usage | Daily usage in Token → Daily usage in Token | 每日用量 → 每日用量 |
| input_36ecb | Input usage → Input usage | 输入用量 → 输入用量 |
| output_b2439 | Output usage → Output usage | 输出用量 → 输出用量 |
| request_activity_365_days | ACTIVITY · LAST 365 DAYS → ACTIVITY · LAST 365 DAYS | 活跃日历 → 活跃日历 |
| daily_recorded_request_activity | Daily recorded activity over 365 days → Daily recorded activity over 365 days | 每日活跃 → 每日活跃 |
| select_a_day_to_inspect_its_model_totals_no_history_is_distinct_ | Select a day to view its usage.<br>No records is different from zero requests. → Select a day for its usage. No records does not mean zero requests. | 点击日期，查看当天用量。<br>没有记录，不等于零次请求。 → 点击日期查看当天用量。<br>没有记录不等于零次请求。 |
| recent_failures | Recent issues → Recent issues | 异常记录 → 异常记录 |
| recent_response_failures | RECENT ISSUES → RECENT ISSUES | 异常记录 → 异常记录 |
| reading_874bf | Reading… → Reading… | 读取中 → 读取中 |
| reading_status | Reading status… → Reading status… | 读取中 → 读取中 |
| upstream_messages_may_contain_sensitive_text | Error details may contain private information. → Error details may include private data. | 错误内容可能含私人信息。 → 错误详情可能含隐私信息。 |
| terminal_animation_9edf6 | TERMINAL ANIMATION → TERMINAL ANIMATION | 终端动效 → 终端动效 |
| animation_theme | Animation style → Animation style | 动效样式 → 动效样式 |
| save_selection | Save animation → Save animation | 保存动效 → 保存动效 |
| applies_on_next_ccdx_start | Save, then restart ccdx to apply. → Save, then restart ccdx to apply. | 保存后，下次启动生效。 → 保存后，下次启动生效。 |
| local_only_no_background_polling | LOCAL ONLY · NO TIMED REFRESH → LOCAL ONLY · NO TIMED REFRESH | 仅在本机查看。不会定时读取。 → 仅在本机查看。不会定时读取。 |
| saved_github_copilot_account_local_credentials_only_not_an_onlin | Saved local sign-in details only.<br>Online access has not been checked. → Saved sign-in only. Online access has not been checked. | 仅查看本机保存的登录信息。<br>尚未核实在线使用权限。 → 仅显示已保存的登录信息。<br>尚未核实访问权限。 |
| github_reading | GitHub / READING → GitHub / READING | GitHub / 读取中 → GitHub / 读取中 |
| github_unavailable | GitHub / UNAVAILABLE → GitHub / UNAVAILABLE | GitHub / 无法读取 → GitHub / 无法读取 |
| github_not_configured | GitHub / NOT SET UP → GitHub / NOT SET UP | GitHub / 未设置 → GitHub / 未设置 |
| github_invalid | GitHub / INVALID DETAILS → GitHub / INVALID DETAILS | GitHub / 信息无效 → GitHub / 信息无效 |
| github_account_saved | GitHub / {account} / SAVED → GitHub / {account} / SAVED | GitHub / {account} / 已保存 → GitHub / {account} / 已保存 |
| account_unknown | account unknown → account unknown | 账号未知 → 账号未知 |
| pid_pid_uptime_duration | PID {pid} · running {duration} → PID {pid} · running {duration} | 进程编号：{pid} · 已运行：{duration} → 进程编号：{pid} · 已运行：{duration} |
| bound | IDENTIFIED → IDENTIFIED | 已识别 → 已识别 |
| unconfirmed | UNCONFIRMED → NOT CONFIRMED | 待确认 → 未确认 |
| service_token_ttl_duration | Access details expire in {duration} → Sign-in valid for {duration} | 有效期：{duration} → 登录信息剩余有效期：{duration} |
| service_token_not_cached | No saved access details yet. → No saved access details. | 还没有暂存授权信息。 → 暂无已保存的访问信息。 |
| source_source_live_ccdx_models | Source: {source}<br>Online list: ccdx models → List: {source}<br>Check online: ccdx models | 来源：{source}<br>在线目录：ccdx models → 列表来源：{source}<br>在线查询：<br>ccdx models |
| built_in | built-in list → built-in list | 内置目录 → 内置列表 |
| cache | existing list → existing list | 已有目录 → 已有列表 |
| live | online list → online list | 在线目录 → 在线列表 |
| unknown_b23a6 | unknown → unknown | 未知 → 未知 |
| 4xx_client_5xx_server_active_active | 4xx {client} · 5xx {server} · active {active} → 4xx {client} · 5xx {server} · active {active} | 4xx {client} · 5xx {server} · 进行中 {active} → 4xx {client} · 5xx {server} · 进行中 {active} |
| raw_raw_decoded_decoded | Received: {raw}<br>Unpacked: {decoded} → Received limit: {raw}<br>After unpacking: {decoded} | 接收上限：{raw}<br>展开上限：{decoded} → 接收上限：{raw}<br>展开后上限：{decoded} |
| entries_entries_trees_trees_misses_misses_evicted_evicted | Records: {entries} · groups: {trees}<br>Not found: {misses} · after removal: {evicted} → Records: {entries} / groups: {trees}<br>Not found: {misses} / removed: {evicted} | 记录：{entries}条 · 历史分组：{trees}组<br>未找到：{misses}次<br>清出后未找到：{evicted}次 → 暂存：{entries}条／分组：{trees}<br>未找到：{misses}<br>清理后未找到：{evicted} |
| count_succeeded | {count} succeeded → {count} succeeded | 成功：{count}次 → 成功：{count}次 |
| not_initialized | UNCONFIRMED → NOT CONFIRMED | 尚未确认 → 未确认 |
| active_active_failed_failed_delivery_failures_delivery | Active: {active} · failed: {failed}<br>Delivery failures: {delivery} → Running: {active} / generation failed: {failed}<br>File delivery failed: {delivery} | 进行中：{active} · 生成失败：{failed}<br>交付失败：{delivery} → 进行中：{active}／生成失败：{failed}<br>文件交付失败：{delivery} |
| setup_state_unknown_ccdx_image_status | Check setup:<br>ccdx image-status → Check setup:<br>ccdx image-status | 查看设置：<br>ccdx image-status → 查看设置：<br>ccdx image-status |
| snapshot_time | Status updated {time} → Status updated {time} | 状态更新：{time} → 状态更新：{time} |
| status_unavailable_check_ccdx_then_refresh | Cannot read status. Check ccdx, then refresh. → Cannot read status. Check CCDX and refresh. | 状态读取失败，请检查后刷新。 → 无法读取状态。<br>请检查 CCDX 后刷新。 |
| count_retained_requests_events | {count} records retained → {count} records retained | 保留：{count}条 → 保留：{count}条 |
| no_recent_request_failures_recorded | No recent issues recorded. → No recent issues recorded. | 暂未记录异常。 → 暂未记录异常。 |
| request_ended_without_successful_completion | This request did not finish successfully. → This request did not finish. | 该请求未能完整完成。 → 本次请求未完成。 |
| detail_retry | {detail} / {retry} → {detail} / {retry} | {detail} / {retry} → {detail} / {retry} |
| retry_attempted | retried → retried | 已重试 → 已重试 |
| no_retry | not retried → not retried | 未重试 → 未重试 |
| time | Time → Time | 时间 → 时间 |
| model_9372c | Model → Model | 模型 → 模型 |
| event | Event type → Record type | 事件类型 → 记录类型 |
| code | Error code → Error code | 错误代码 → 错误代码 |
| message | Error details → Error details | 错误详情 → 错误详情 |
| response_id | Response ID → Response ID | 回答编号 → 回答编号 |
| upstream_request_id | Provider request ID → Source request ID | 服务编号 → 来源编号 |
| request_id | Local request ID → CCDX request ID | 本机编号 → 本机编号 |
| outcome_25a63 | Result → Result | 处理结果 → 处理结果 |
| origin | Reported by → Result source | 结果来源 → 结果来源 |
| route | Request route → Request route | 请求入口 → 请求入口 |
| http_request_failed_original_response_was_preserved | HTTP request failed. The original error was returned. → HTTP request failed. The original error was returned. | 请求失败，已返回原始错误。 → 请求失败，已返回原始错误。 |
| phase | Last step → Last step | 最后步骤 → 最后步骤 |
| http_status | HTTP status → HTTP status | 返回状态 → 返回状态 |
| upstream_attempts | Send attempts → Send attempts | 发送次数 → 发送次数 |
| timings_ms | Timeline (ms) → TIMING (ms) | 时间记录（毫秒） → 处理耗时（毫秒） |
| retry | Retry status → Retry status | 重试情况 → 重试情况 |
| retry_policy | Retry rule → Retry rule | 重试规则 → 重试规则 |
| retry_skipped | Skip reason → Skip reason | 跳过原因 → 跳过原因 |
| recovery | Recovery → Recovery | 恢复处理 → 恢复处理 |
| attempted_outcome_not_recorded_here | Retried; result not recorded here. → Retried. This record has no final result. | 已重试；这里未记录结果。 → 已重试。<br>此条记录不含最终结果。 |
| attempted | retried → retried | 已重试 → 已重试 |
| not_attempted | not retried → not retried | 未重试 → 未重试 |
| copy_diagnostic | Copy details → Copy details | 复制详情 → 复制详情 |
| copied | Copied → Copied | 已复制 → 已复制 |
| copy_unavailable | Copy failed → Copy failed | 复制失败 → 复制失败 |
| default | DEFAULT → DEFAULT | 默认 → 默认 |
| disabled_by_ccdx_terminal_animation_saved_choice_applies_after_o | Disabled by CCDX_TERMINAL_ANIMATION.<br>Remove this setting, then restart to apply your saved choice. → Startup setting disables animation. Remove it and restart to use the saved choice.<br>CCDX_TERMINAL_ANIMATION | 启动设置已关闭动效。<br>CCDX_TERMINAL_ANIMATION<br>移除此设置后，重启生效。 → 启动设置已关闭动效。<br>移除后重启可恢复所选动效。<br>CCDX_TERMINAL_ANIMATION |
| saved_choice_applies_on_next_ccdx_start | Saved choice applies after restarting ccdx. → Saved choice applies after restarting ccdx. | 保存后，下次启动生效。 → 保存后，下次启动生效。 |
| current_theme_unsaved | SAVED {theme}{unsaved} → SAVED {theme}{unsaved} | 已保存：{theme}{unsaved} → 已保存：{theme}{unsaved} |
| unsaved |  / UNSAVED →  / UNSAVED |  / 待保存 →  / 待保存 |
| saving | Saving… → Saving… | 保存中 → 保存中 |
| not_saved_error | Not saved: {error} → Not saved: {error} | 保存失败：{error} → 保存失败：{error} |
| preview | preview → preview | 测试版 → 预览版 |
| no_selectable_gpt_models_advertised | No selectable GPT models found. → No GPT models available to select. | 暂未发现可选GPT模型。 → 暂无可选 GPT 模型。 |
| live_snapshot | FETCHED → FETCHED | 已获取 → 已获取 |
| selectable_selectable_advertised_advertised_host_time | Selectable: {selectable} · listed: {advertised}<br>Source: {host} · checked {time} → Selectable: {selectable} / listed: {advertised}<br>Source: {host} / checked: {time} | 可选：{selectable}个 · 服务列出：{advertised}个<br>来源：{host} · 获取时间：{time} → 可选：{selectable}／列出：{advertised}<br>来源：{host}<br>查询时间：{time} |
| live_lookup_failed | CHECK FAILED → CHECK FAILED | 查询失败 → 查询失败 |
| no_live_catalog_available | Cannot get the model list. → Cannot get the model list. | 无法获取模型列表。 → 无法获取模型列表。 |
| no_usage_records | No usage records yet. → No usage records yet. | 暂未记录用量。 → 暂未记录用量。 |
| local_log | LOCAL RECORDS → LOCAL RECORDS | 本机记录 → 本机记录 |
| records_records_shown_of_models_models_shown_day | Records: {records} · models: {shown} of {models}{day} → Records: {records} · models: {shown} of {models}{day} | 记录：{records}条<br>模型：展示{shown}个，共{models}个{day} → 记录：{records}条<br>模型：展示{shown}个，共{models}个{day} |
| zone_model |  / {zone} / {model} →  / {zone} / {model} |  / {zone} / {model} →  / {zone} / {model} |
| no_retained_history | no records → no records | 没有记录 → 没有记录 |
| calls_recorded_calls_input_input_output_output_cached_cached_inc | {calls} recorded requests<br>Input: {input} · output: {output} · reused: {cached} Token<br>Reused input is included in input usage.{partial} → {calls} recorded requests<br>Input: {input} / output: {output}<br>Reused input: {cached} Token<br>Reused input is part of input.{partial} | 请求：{calls}次<br>输入用量：{input} Token<br>输出用量：{output} Token<br>重用输入：{cached} Token<br>重用部分已计入输入用量。{partial} → 已记录请求：{calls}<br>输入：{input}／输出：{output}<br>复用输入：{cached} Token<br>复用部分已计入输入。{partial} |
| partial_token_counts | <br>Incomplete usage records. → <br>Incomplete usage records. | <br>用量记录不完整。 → <br>用量记录不完整。 |
| date_description | {date} / {description} → {date} / {description} | {date} / {description} → {date} / {description} |
| metric_peak_peak | 365 DAYS · {metric} · PEAK {peak} → 365 DAYS · {metric} · PEAK {peak} | 近365天 · {metric} · 峰值{peak} → 近365天 · {metric} · 峰值{peak} |
| input_output | TOTAL USAGE (Token) → TOTAL USAGE (Token) | 总用量 → 总用量 |
| recorded_calls | RECORDED REQUESTS → RECORDED REQUESTS | 请求次数 → 请求次数 |
| zone_from_to_retained_history_starts_first_oldest_day_may_be_par | {zone} · {from} — {to}<br>Earliest record: {first}. That day may be incomplete.{excluded}{limit} → Zone: {zone}<br>Range: {from}–{to}<br>First record: {first}<br>The first day may be partial.{excluded}{limit} | 时区：{zone}<br>记录范围：{from}—{to}<br>最早记录：{first}<br>最早一天的记录可能不全。{excluded}{limit} → 时区：{zone}<br>记录范围：{from}—{to}<br>最早记录：{first}<br>最早一天可能记录不全。{excluded}{limit} |
| count_records_with_invalid_future_timestamps_excluded | <br>Skipped {count} records with invalid or future dates. → <br>Skipped {count} records with invalid or future dates. | <br>已跳过{count}条时间异常记录。 → <br>已跳过{count}条时间异常记录。 |
| model_filters_limited_to_100_all_model_totals_include_the_remain | <br>Filters show up to 100 models. Totals include the rest. → <br>Filters show up to 100 models. Totals include the rest. | <br>只列出前100个模型。<br>总计包含其余模型。 → <br>只列出前100个模型。<br>总计包含其余模型。 |
| selected_date_model_totals_in_the_usage_table_above_all_history_ | Selected: {date} / {model}. See the usage table above.<br>Choose Show all to reset the date. → Selected: {date} / {model}<br>Usage is in the table above.<br>Show all clears the date filter. | 已选：{date}／{model}<br>当天用量见上方表格。<br>点击“查看全部”恢复总表。 → 已选：{date}／{model}<br>当天用量见上方表格。<br>“查看全部”会清除日期筛选。 |
| select_a_day_for_model_totals_calls_are_usage_records_not_messag | Select a day to view its usage.<br>Counts are recorded requests, not messages or time.<br>Hatched: no records. Blank: zero recorded requests. → Select a day for usage.<br>Counts are requests, not messages or time.<br>Hatched: no records. Blank: zero recorded requests. | 点击日期，查看当天用量。<br>按已记录的请求统计。<br>不代表消息数或使用时长。<br>斜线格表示没有记录。<br>空白格表示已记录零次请求。 → 点击日期查看当天用量。<br>统计请求，不代表消息或时长。<br>斜线格：没有记录。<br>空白格：记录为零次请求。 |
| log_unavailable | READ FAILED → READ FAILED | 读取失败 → 读取失败 |
| no_usage_summary_available | Cannot read usage records. → Cannot read usage records. | 无法读取用量记录。 → 无法读取用量记录。 |
| analytics_unavailable_refresh_usage_to_retry | Trends unavailable. Refresh Model usage to retry. → Trends unavailable. Refresh Model usage to retry. | 统计失败，请刷新用量。 → 统计失败，请刷新用量。 |
| animation_settings_are_invalid_inspect_them_with_ccdx_animation | Invalid animation settings.<br>Run ccdx animation. → Invalid animation setting.<br>Run ccdx animation. | 设置无效，请检查动效。<br>运行ccdx animation。 → 动效设置无效。<br>ccdx animation |
| animation_setting_was_not_saved_check_ccdx_animation | Animation was not saved.<br>Run ccdx animation. → Could not save animation.<br>Run ccdx animation. | 保存失败，请检查动效。<br>运行ccdx animation。 → 动效未能保存。<br>ccdx animation |
| could_not_read_local_usage_summary | Cannot read usage. Refresh to retry. → Cannot read usage. Refresh to retry. | 无法读取用量，请刷新。 → 无法读取用量，请刷新。 |
| live_model_lookup_timed_out_retry_or_run_ccdx_models | Model check timed out. Try again.<br>Run ccdx models for details. → Model lookup timed out. Try again.<br>Details: ccdx models. | 模型查询超时，请重试。<br>运行ccdx models。 → 模型查询超时，请重试。<br>ccdx models |
| github_token_not_found_start_ccdx_to_sign_in | No GitHub sign-in details found.<br>Run ccdx to sign in. → No saved GitHub sign-in.<br>Run ccdx to sign in. | 未找到登录信息。<br>运行ccdx登录。 → 未找到 GitHub 登录信息。<br>运行 ccdx 登录。 |
| live_model_lookup_failed_run_ccdx_models_for_details | Model check failed.<br>Run ccdx models for details. → Could not get models.<br>Details: ccdx models. | 模型查询失败，请查看详情。<br>运行ccdx models。 → 模型查询失败。<br>ccdx models |
| live_model_lookup_failed_http_status_run_ccdx_models_for_details | Model check failed: HTTP {status}.<br>Run ccdx models for details. → Model lookup failed: HTTP {status}.<br>Details: ccdx models. | 模型查询失败：HTTP {status}<br>运行ccdx models。 → 模型查询失败：HTTP {status}<br>ccdx models |
| select_a_listed_animation_theme | Choose an animation from the list. → Choose an animation from the list. | 请选择列表中的动效。 → 请选择列表中的动效。 |
| animation_changes_require_the_same_origin_dashboard | Save from this computer's dashboard. → Save from this computer’s dashboard. | 请从本机看板保存动效。 → 请从本机面板保存动效。 |
| animation_changes_require_application_json | The save format is invalid. → Invalid save format. | 保存内容格式不正确。 → 保存格式有误。 |
| invalid_animation_request_body | The animation selection is invalid. → Invalid animation choice. | 动效选择格式不正确。 → 动效选择有误。 |
| select_a_valid_usage_time_zone | Choose a valid time zone. → Choose a valid time zone. | 所选时区无效。 → 所选时区无效。 |
| method_not_allowed | This action is not supported. → This action is not supported. | 此操作不受支持。 → 此操作不受支持。 |
| dashboard_api_is_available_only_at_a_loopback_address | Open the dashboard on this computer. → Open the dashboard on this computer. | 请在本机打开看板。 → 请在本机打开面板。 |
| dashboard_api_requires_a_same_origin_page_request | Use this computer's dashboard to continue. → Use this computer’s dashboard. | 请从本机看板操作。 → 请从本机面板操作。 |
| time_model_code | {time} / {model} / {code} → {time} / {model} / {code} | {time} / {model} / {code} → {time} / {model} / {code} |
| unknown_time | unknown time → unknown time | 时间未知 → 时间未知 |
| unknown_model | unknown model → unknown model | 模型未知 → 模型未知 |
| unknown_error | unknown error → unknown error | 错误未知 → 错误未知 |
| index_theme | {index} {theme} → {index} {theme} | {index} {theme} → {index} {theme} |
| comet | Comet → Comet | 彗星 → 彗星 |
| twin | Twin → Twin | 双星 → 双星 |
| shuttle | Shuttle → Shuttle | 往返 → 往返 |
| chase | Chase → Chase | 追逐 → 追逐 |
| mirror | Mirror → Mirror | 对称 → 对称 |
| pulse | Pulse → Pulse | 呼吸 → 呼吸 |
| stack | Stack → Stack | 堆叠 → 堆叠 |
| relay | Relay → Relay | 接力 → 接力 |
| split | Split → Split | 分岔 → 分岔 |
| comet_793f4 | COMET → COMET | 彗星 → 彗星 |
| twin_98571 | TWIN → TWIN | 双星 → 双星 |
| shuttle_6ba52 | SHUTTLE → SHUTTLE | 往返 → 往返 |
| chase_12353 | CHASE → CHASE | 追逐 → 追逐 |
| mirror_ddb33 | MIRROR → MIRROR | 对称 → 对称 |
| pulse_64ab2 | PULSE → PULSE | 呼吸 → 呼吸 |
| stack_c6573 | STACK → STACK | 堆叠 → 堆叠 |
| relay_dbb36 | RELAY → RELAY | 接力 → 接力 |
| split_6cc37 | SPLIT → SPLIT | 分岔 → 分岔 |
| saved_saved_state | 新增 → Saved {saved} / {state} | 新增 → 已保存：{saved}<br>{state} |
| could_not_read_settings | 新增 → Could not read settings | 新增 → 无法读取设置 |
| showing_previous_data_updated_time | 新增 → Showing previous data / updated {time} | 新增 → 显示上次数据<br>上次更新：{time} |
| no_data_received | 新增 → No data received | 新增 → 尚未读到数据 |
| codex_source_source | 新增 → Codex source: {source} | 新增 → Codex 来源：{source} |
| microsoft_365_state | 新增 → Microsoft 365: {state} | 新增 → Microsoft 365：{state} |
| settings_restored | 新增 → Settings restored | 新增 → 已恢复设置 |
| time_left | 新增 → Time left | 新增 → 有效期 |
| requests_by_source | 新增 → REQUESTS BY SOURCE | 新增 → 来源统计 |
| no_requests_observed | 新增 → No requests observed. | 新增 → 尚未收到请求。 |
| protocol | 新增 → Protocol | 新增 → 请求接口 |
| active | 新增 → Active | 新增 → 进行中 |
| results_since_startup_partial_usage_is_marked_separately | 新增 → Results since startup. Partial usage is marked separately. | 新增 → 统计本次运行的请求。<br>用量缺失会单独标明。 |
| claude_code_code_claude_app_app | 新增 → Claude Code: {code} / Claude App: {app} | 新增 → Claude Code：{code}<br>Claude App：{app} |

## 1.2.3 公司账号补充

以下为新增交互，现有主题与布局保持。英文错误详情可保留，已知账号状态使用双语提示。

| 原文案或状态 → 新英文 | 新中文 |
| --- | --- |
| 无账号区域 → Company account | 公司账号 |
| 无发现操作 → Check accounts | 检查账号 |
| 无选择入口 → Choose a company account | 选择公司账号 |
| 无提交操作 → Use this account | 使用此账号 |
| `m365_account_ambiguous` → Choose a company account below. | 请在下方选择公司账号。 |
| 无列表说明 → Choose an account. Browsing does not change your connection. | 请选择账号。查看列表不会切换。 |
| 无范围说明 → Applies to Microsoft 365 in Codex and Claude. Start a new conversation after changing accounts. | 影响 Codex 和 Claude 的 M365 服务。／更换账号后请新建对话。 |
| 无成功状态 → Account connected. Model list checked; inference access is not tested. | 账号已连接，模型列表已检查。／尚未测试实际请求。 |
| 无失败保留状态 → Account not changed. Previous connection kept. | 账号未更换，保留原连接。 |
| 无选择来源 → Windows sign-in / Only company account / Your choice / Saved account | Windows 登录账号／唯一公司账号／手动选择／已保存账号 |

完整新增固定消息以 `src/dashboard/language.js` 的公司账号消息为准；账号邮箱与租户是原始身份数据，不作长度截断来冒充名称。

## 1.2.4 导航与版本信息增量

侧栏重复的 Terminal appearance 入口移除；设置页内的功能和中英文名称保留。来源摘要由应用映射改为完整来源名单，来源数量包括已发现但未启用的来源。

| 固定标识 | 原英文 → 新英文 | 原中文 → 新中文 |
| --- | --- | --- |
| provider_status_scope | 新增 → Source and application status | 新增 → 模型来源与应用状态 |
| version_updates | 新增 → VERSION & UPDATES | 新增 → 版本与更新 |
| copy_command | 新增 → Copy command | 新增 → 复制指令 |
| check_updates | 新增 → Check for updates | 新增 → 检查更新 |
| checking_updates | 新增 → Checking… | 新增 → 正在检查… |
| current_version | 新增 → Current version | 新增 → 当前版本 |
| available_update | 新增 → Update available | 新增 → 可用更新 |
| last_known_version | 新增 → Last known version | 新增 → 上次查到的版本 |
| released_date | 新增 → Released {date} | 新增 → 发布于 {date} |
| release_date_unknown | 新增 → Release date unknown | 新增 → 发布日期未知 |
| new_version_available | 新增 → A new version is available. | 新增 → 发现新版本。 |
| already_latest | 新增 → You’re up to date. | 新增 → 已是最新版本。 |
| update_check_failed | 新增 → Could not check updates. Latest version unknown. | 新增 → 暂时无法检查，最新版本未知。 |
| update_rate_limited | 新增 → GitHub limited update checks. Try again later. | 新增 → GitHub 限制了检查，请稍后再试。 |
| update_restart | 新增 → Run in your terminal, then restart CCDX. | 新增 → 在终端运行，完成后重启 CCDX。 |
| update_checked_time | 新增 → Last checked: {time} | 新增 → 上次检查：{time} |
| update_attempted_time | 新增 → Last attempt: {time} | 新增 → 最近尝试：{time} |
| update_install_help | 新增 → Update failed? View full installation commands | 新增 → 更新遇到问题？查看完整安装指令 |
| installation_platform | 新增 → Installation platform | 新增 → 安装平台 |
| update_install_hint | 新增 → Download the official installer. No Git required. | 新增 → 下载官方安装器，无需 Git。 |
| update_install_policy | 新增 → Reuses compatible Node/npm or installs a private runtime. Keeps your registry, proxy, certificates and shell policy. | 新增 → 复用可用的 Node/npm，否则安装专用运行环境。<br>保留镜像、代理、证书和脚本策略。 |
| update_windows_policy | 新增 → If scripts are blocked, use your company’s approved installation method. | 新增 → 若公司禁止运行脚本，请使用公司批准的安装方式。 |
| update_copy_unavailable | 新增 → Clipboard unavailable. Select the command and copy it. | 新增 → 无法自动复制，请选中指令复制。 |

## 1.2.5 用量图表与本次缓存复用

| 固定标识 | 原英文 → 新英文 | 原中文 → 新中文 |
| --- | --- | --- |
| chart_view | 新增 → Chart view | 新增 → 图表视图 |
| bar_chart | 新增 → Bar chart | 新增 → 柱状图 |
| line_chart | 新增 → Line chart | 新增 → 曲线图 |
| approx_cache_hit_rate | 新增 → Approx. cache hit rate | 新增 → 粗略缓存命中率 |
| runtime_cache_hit_basis | 新增 → Reused input / input tokens. ~ Partial counts. — Unknown or invalid. | 新增 → 复用输入 ÷ 输入 Token。<br>~：数据不完整。—：未知或无效。 |

## 1.2.6 系统代理诊断增量

原状态仅列 `Unavailable / m365_proxy_settings_unsupported`。已知代理设置错误改为状态加具体原因；原错误大类、具体原因码和阶段保留在详情。布局、配色和功能开关不变；CLI 继续英文。

| 固定标识 | 新英文 | 新中文 |
| --- | --- | --- |
| network_route_source | Network settings | 网络设置来源 |
| network_failure_stage | Failed at | 失败阶段 |
| network_cause_code | Cause code | 原因代码 |
| network_source_system | System settings | 系统设置 |
| network_source_environment | Environment variables | 环境变量 |
| network_stage_proxy_discovery | Read system proxy settings | 读取系统代理 |
| network_stage_proxy_config | Interpret proxy rules | 解析代理规则 |
| network_cause_proxy_discovery_failed | Could not read system proxy settings. Existing settings kept. | 无法读取系统代理。原设置已保留。 |
| network_cause_proxy_bypass_invalid | Invalid proxy exception rule. Existing settings kept. | 代理例外规则无效。原设置已保留。 |
| network_cause_proxy_system_invalid | Invalid system proxy address or port. Existing settings kept. | 系统代理地址或端口无效。原设置已保留。 |
| network_cause_proxy_address_invalid | Invalid proxy address. Existing settings kept. | 代理地址无效。原设置已保留。 |
| network_cause_proxy_address_unsupported | Unsupported proxy address format. Existing settings kept. | 代理地址格式不支持。原设置已保留。 |
| network_cause_proxy_dynamic_unsupported | System PAC or WPAD is not supported. Existing settings kept. | 暂不支持系统自动代理。原设置已保留。 |
| network_cause_proxy_settings_unsupported | Could not interpret proxy settings. Existing settings kept. | 无法解析代理设置。原设置已保留。 |

技术提示 `network_detail` 保留四个占位符：`{source} / {stage} / {code} / {category}`，随语言切换重新翻译说明，技术码保持原值。
