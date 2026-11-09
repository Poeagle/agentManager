# Codex 问题与回归用例

每个已确认问题保留独立命名的回归用例，描述触发条件和可观察结果；修复前应能失败，
修复后通过。不要以修改断言、跳过用例或仅记录一次手工成功代替修复。
测试使用临时数据库、模拟原生协议和隔离项目，不调用真实模型、不消耗账号额度。

## 执行入口

```bash
npm run test:regression:conversation
npm run test:regression:accounts
```

两条命令各自包含服务端、页面组件和浏览器 E2E。先安装项目依赖及 Playwright Chromium
（`npx playwright install chromium`）；如浏览器安装在其他目录，用 `PLAYWRIGHT_BROWSERS_PATH`
指定位置。E2E 使用独立的 43110/43111 端口，请顺序运行这两条命令。它们不启动 Claude。

## 对话页面

| 问题 / 触发条件 | 预期结果 | 自动化用例 |
|---|---|---|
| 本地发送气泡与原生回执先后到达、HTTP 回应较晚 | 通过 client_id 合并为一个气泡，不清掉新草稿 | [SessionConversationSend.test.tsx](../dashboard/tests/SessionConversationSend.test.tsx) 的 delayed acknowledgement / native echo 用例 |
| 用户有意连续发送相同文字 | 两条消息保留，不能按文字去重 | [conversation-timeline.test.ts](../dashboard/tests/conversation-timeline.test.ts) 的 intentional identical messages；[conversation-duplicate-input.spec.ts](../e2e/conversation-duplicate-input.spec.ts) |
| 原生完成事件和 rollout 同时含同一输入或回答 | 依据原生 item 身份只显示一次 | [conversation-reader.test.ts](../server/tests/conversation-reader.test.ts) 的 completed Codex UserMessage identity / completed agent item 用例 |
| 历史晚于实时消息到达，时间戳或 turn 容器不同 | 用户、进展、回答按原生顺序合并，无重复、不按时钟重排 | [conversation-order.spec.ts](../e2e/conversation-order.spec.ts)；[conversation-timeline.test.ts](../dashboard/tests/conversation-timeline.test.ts) 的 durable gaps 用例 |
| 旧的历史投影比已显示的流式回答短 | 正文不回退、不被较短版本覆盖 | [conversation-timeline.test.ts](../dashboard/tests/conversation-timeline.test.ts) 的 stale history frame 用例 |
| 历史文件被替换，原来的 after 游标仍存在 | 服务端返回完整基线；页面不得用增量尾部覆盖旧消息 | [conversation-reader.test.ts](../server/tests/conversation-reader.test.ts) 的 replaced history baseline；[SessionConversationSend.test.tsx](../dashboard/tests/SessionConversationSend.test.tsx) 的 replaced history generation；[conversation-history-replacement.spec.ts](../e2e/conversation-history-replacement.spec.ts) |
| 跨用户历史镜像只是新增一轮 | 保持 inode、generation 和已加载的旧分页 | [codex-account-files.test.ts](../server/tests/codex-account-files.test.ts) 的 appended turns 用例 |
| 历史发生实际重写 | 更换 generation，移除失效内容并重新读取基线 | [codex-account-files.test.ts](../server/tests/codex-account-files.test.ts) 的 actual transcript rewrite 用例 |
| 断网、半开连接、增量序号缺口 | 重新获取基线，保留草稿，不重发用户输入 | [SessionConversationSend.test.tsx](../dashboard/tests/SessionConversationSend.test.tsx) 的 browser resume / stream gap；[conversation-reconnect.spec.ts](../e2e/conversation-reconnect.spec.ts) |
| 切换原始终端/对话视图，或刷新页面 | 已有气泡内容与顺序保持一致 | [conversation-order.spec.ts](../e2e/conversation-order.spec.ts)；[conversation-history-replacement.spec.ts](../e2e/conversation-history-replacement.spec.ts) |

## 账号与 Provider

| 问题 / 触发条件 | 预期结果 | 自动化用例 |
|---|---|---|
| 两个登录账号都使用 openai Provider | 以环境 ID 路由，不能串到另一个账号 | [codex-environments.test.ts](../server/tests/codex-environments.test.ts) 的 two OpenAI accounts 用例 |
| 普通用户未获授权，或管理员不在授权列表 | 普通用户不可见且直接请求拒绝；管理员默认有权配置和使用 | [codex-environments.test.ts](../server/tests/codex-environments.test.ts) 的 private accounts / direct REST / administrators 用例；[codex-environments.spec.ts](../e2e/codex-environments.spec.ts) |
| 收回使用权限 | 已连接页面/终端关闭，不回退到别的账号 | [codex-environments.test.ts](../server/tests/codex-environments.test.ts) 的 revokes existing tabs 用例 |
| 已登录账号、缺少登录、SSH 认证或连接错误 | 复用已有登录；缺登录只提示目标用户登录；预检准确显示失败阶段 | [codex-account-transport.test.ts](../server/tests/codex-account-transport.test.ts)；[codex-environments.test.ts](../server/tests/codex-environments.test.ts) 的 distinct preflight step；[CodexEnvironments.test.tsx](../dashboard/tests/CodexEnvironments.test.tsx) |
| 在同一 Provider 页面填写 SSH 密码并保存/修改 | 密码加密，不出现在参数、助手文件及返回 DTO；空值保留原密码 | [codex-account-transport.test.ts](../server/tests/codex-account-transport.test.ts) 的 password askpass；[codex-environments.test.ts](../server/tests/codex-environments.test.ts) 的 encrypts SSH passwords；[CodexEnvironments.test.tsx](../dashboard/tests/CodexEnvironments.test.tsx) |
| 空闲会话切换账号 | 完整原生记录保留，目标恢复成功后才换绑定，不自动发送任务 | [codex-environment-transfer.test.ts](../server/tests/codex-environment-transfer.test.ts) 的 full native transfer 用例 |
| 分页历史包含祖先、工具结果或后来新增的兄弟分支 | 只迁移正确祖先前缀，保留工具与子会话，不携带后来的分支，不改原始文件 | [codex-history-bundle.test.ts](../server/tests/codex-history-bundle.test.ts) 的 ancestor prefixes / projects inherited turns 用例 |
| 分页祖先缺失、字节截断或 ordinal 错误 | 拒绝迁移，不以空白会话冒充成功 | [codex-history-bundle.test.ts](../server/tests/codex-history-bundle.test.ts) 的 missing ancestor / corrupt prefix 用例 |
| 目标恢复失败或迁移中原会话又开始执行 | 清理或归档目标副本，保留原绑定和历史 | [codex-environment-transfer.test.ts](../server/tests/codex-environment-transfer.test.ts)；[conversation-new.test.ts](../server/tests/conversation-new.test.ts) |
| Provider 有正在执行的任务 | 禁止调整连接和重启 | [codex-environment-usage.test.ts](../server/tests/codex-environment-usage.test.ts) 的 rejects a running model task；[codex-environments.spec.ts](../e2e/codex-environments.spec.ts) 的 pending tabs 用例 |
| 任意用户仍保留空闲或已停止的标签页 | 表格全部列出；可以调整，不能删除 Provider | [codex-environment-usage.test.ts](../server/tests/codex-environment-usage.test.ts) 的 ended-but-open tabs；[codex-environments.spec.ts](../e2e/codex-environments.spec.ts) 的 idle tabs from every user |
| 单独关闭一个用户的标签页 | 其他用户的标签页保留，仍禁止删除 Provider | [codex-environment-usage.test.ts](../server/tests/codex-environment-usage.test.ts) 的 closes one selected tab；[codex-environments.spec.ts](../e2e/codex-environments.spec.ts) |
| 跨用户批量关闭标签页 | 确认后停止并删除所选标签页，历史记录保留；全部关闭后才能删 Provider | [ProviderUsageTable.test.tsx](../dashboard/tests/ProviderUsageTable.test.tsx)；[codex-environment-usage.test.ts](../server/tests/codex-environment-usage.test.ts)；[codex-environments.spec.ts](../e2e/codex-environments.spec.ts) |
| 批量操作部分失败 | 显示失败项、保留失败标签页，不误删其他 Provider 的会话 | [ProviderUsageTable.test.tsx](../dashboard/tests/ProviderUsageTable.test.tsx) 的 partial failure；[codex-environment-usage.test.ts](../server/tests/codex-environment-usage.test.ts) 的 partial success |
| 普通成员的薄终端客户端启动 | 仅绑定授权项目、独立 HOME 和连接通道；缺失的隔离路径不导致启动失败 | [terminal-worker-controls.test.ts](../server/tests/terminal-worker-controls.test.ts) 的 member namespace 用例 |

真实双账号测试另外验证目标系统用户、项目路径、上下文回忆、原生历史双向复制和浏览器
展示。真实 SSH 密钥路径、登录凭据及会话内容不进入测试仓库；实际 SSH 密码认证仍需在
具备对应认证条件的环境验收，自动化覆盖密码传递、加密、保留及错误展示。
