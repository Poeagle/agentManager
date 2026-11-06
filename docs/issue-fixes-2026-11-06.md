# 2026-11-06 GitHub issue 排查与修复

检查基线：`4eba892`；范围：Poeagle/agentManager 未关闭的 #1–#9，以及本轮追加的活动状态、Fast 和取消排队问题。

| Issue | 确认的问题与处理 | 主要验证 |
| --- | --- | --- |
| [#1](https://github.com/Poeagle/agentManager/issues/1) | 原生消息把 thread ID 错填为 turn ID 时，剔除错误身份，由轮次生命周期补齐。保留不同轮次的合法同文回复。 | conversation-reader；桌面 legacy identity 用例覆盖切标签、刷新、重复回复 |
| [#2](https://github.com/Poeagle/agentManager/issues/2) | 增加显式 provider→独立引擎→模型目录路由；控制、输入、重试、实时流、终端和恢复共用会话所属引擎。跨 provider 切换需要确认新开会话，保留旧记录。 | 两个模拟原生引擎、混合目录过滤、冷启动元数据恢复、原生/终端路由 |
| [#3](https://github.com/Poeagle/agentManager/issues/3) | 创建任务前核对配置模型与当前引擎目录；恢复时识别失效的历史模型，要求显式修正。未加载会话先带修正参数恢复，再更新并核对设置。原生错误保留原因并清理常见凭据字段。 | provider engines；controls；没有发送真实模型请求 |
| [#4](https://github.com/Poeagle/agentManager/issues/4) | 内嵌终端保留用户 daemon 的插件/hook 功能开关；仅平台独立引擎使用匹配的插件禁用参数。启动冲突菜单识别为等待处理。 | CLI command、startup state；没有重启全局 daemon |
| [#5](https://github.com/Poeagle/agentManager/issues/5) | API 路由与 SPA 兜底分离；未知 API 返回 JSON 404，已知路径错方法返回 JSON 405 和 Allow。普通 HTTP 请求访问 WebSocket 路径也返回结构化错误，保留权限检查顺序。 | HTTP fallback、真实路由注册表、RBAC |
| [#6](https://github.com/Poeagle/agentManager/issues/6) | 统一 quota 响应；API Key 不适用额度返回 200、quota:null、reason:not_applicable，界面中性展示“不适用”；真正失败返回结构化 503，并保留缓存/退避。 | quota reader lifecycle、quota response、quota UI |
| [#7](https://github.com/Poeagle/agentManager/issues/7) | macOS 异步读取 vm_stat 的页大小及 free/inactive/speculative 队列，不重复计算 purgeable。复用 5 秒共享采样；采集失败时禁止依据 free-only 估算自动关闭会话。 | Darwin/Intel/Apple Silicon 页大小样本、资源共享采样、memory reaper |
| [#8](https://github.com/Poeagle/agentManager/issues/8) | 支持恢复模型的 Agent 在失败/未加载时仍可保存选择。原生控制是否可用依据引擎状态，不依赖终端是否附着。新会话可选择模型/强度；历史恢复偏好随旧记录转移，避免覆盖新 provider 的设置。 | controls、new conversation、桌面模型切换/草稿保留 |
| [#9](https://github.com/Poeagle/agentManager/issues/9) | 注册 hooks 路由，集中维护启动路由注册表并检测漏挂载。保留项目路径及 RBAC 检查；卸载不删除同项中的其他 hook，损坏 JSON 不会被覆盖。 | route registry、events security |

## 本轮追加问题

- 原生队列核对：截图中“什么进度了”当时确实仍在原生队列，不能靠页面隐藏来声称已执行。按用户明确要求，只取消该条输入，并确认目标不再排队。
- 新增 `cancelQueuedInput` 能力和“取消排队”按钮。通过原生队列 ID 精确删除，拒绝删除已消费消息；检查会话归属和写权限，不发送/重发任务、不打断执行。
- 复现并修复恢复快照与实时事件竞争时，缺失的运行中工具活动被漏补齐的问题；保留对更新完成事件的保护。任务仍忙时，已完成工具改为“执行中 · 最近完成”，避免被理解成整轮完成。
- 原生连接明确退订对话不展示的工具输出和推理增量通知，减少无效传输；工具开始、结束、正文、状态、队列、用量事件继续保留。
- 新增 `serviceTier` 能力与 Fast 开关。档位 ID 来自原生模型目录；关闭发送显式 `default`，与原生客户端行为一致。通过原生设置回执确认后展示成功，支持原生设置事件更新，不创建模型轮次。

## 验证与边界

验证使用隔离数据库、模拟 WebSocket 引擎和桌面 Chromium。完整 server/dashboard 单元测试、两侧构建、更新安全检查，以及桌面模型控制、Fast、队列撤回和重复消息用例均纳入检查；最终结果：服务端 764 项通过、1 项既有跳过；前端 437 项通过；桌面模型控制/Fast/队列撤回用例及 legacy identity 用例通过；两侧构建和更新安全检查通过。构建仍有既有的大 chunk 提示，未新增构建失败。

- 当前机器为 Linux。macOS 计算与失败保护已用样本验证，仍需 macOS 部署环境复核真实监控值和原生终端行为。
- 多 provider 需要显式配置独立引擎及模型白名单，见 README。平台不猜测模型归属，不修改用户全局 provider，也不自动安装或启动额外 Agent。
- 原生模型目录不能证明网关一定接受某个模型；网关配置与目录矛盾仍可能返回错误。保留可操作的错误原因和显式恢复路径，没有使用付费模型调用来探测支持情况。
- 无可用原生 RPC 的纯内嵌终端仍保留原始终端操作路径；平台模型/Fast 控制要求接入可用引擎。
- 未安装或运行 Claude Code；未重启真实原生引擎。真实会话仅做状态核对，以及按用户指定取消一条排队输入。
