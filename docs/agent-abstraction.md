# Agent 接入架构

平台按功能组合接口，各 Agent 负责自己的协议和实现。注册入口为
`server/src/services/agents/index.ts`，纯注册表位于 `registry.ts`；注册表不引用具体厂商。

```mermaid
flowchart TB
  UI[对话、标签状态、模型设置、定时任务] --> API[平台 API：权限、会话锁、历史分页、附件]
  API --> Registry[Agent 注册表与能力描述]
  Registry --> Ports[按功能组合的接口]
  Ports --> Codex[Codex 适配器：app-server、rollout、CLI]
  Ports --> Claude[Claude 适配器：原生历史、终端命令]
  Ports --> Remote[后续 Agent：SDK、ACP、HTTP 或 WebSocket]
```

## 功能边界

| 接口 | 责任 | 接入要求 |
| --- | --- | --- |
| `history` | 返回统一消息、分页、统计；可选本地文件编解码策略 | 必需 |
| `runtime` | 原生执行状态，按需读取与变更通知 | 必需 |
| `input` | 提交对话、区分接受/排队/拒绝，防止模糊失败后重复发送 | 必需 |
| `stream` | 统一事件通道、交互回答、连接释放；可选实时通道升级与关闭钩子 | 必需 |
| `identity` | 原生标识、可选终端识别、旧绑定恢复与本地清理 | 默认使用通用标识，终端识别按需实现 |
| `controls` | 查询、验证、应用模型与推理设置 | 按能力声明 |
| `telemetry` / `statistics` | 用量与消息区间统计，未知数据保持空值 | 按能力声明 |
| `quota` / `retry` | 账户额度、失败判断与原生重试操作 | 按能力声明 |
| `lifecycle` / `launch` | 预检、压缩、新对话、中断、释放、启动/恢复准备 | 按能力声明 |
| `commands` | CLI 命令构造、权限和共享资源参数 | 仅终端宿主需要 |

`AgentDefinition` 是新增 Agent 的实现契约；`resolveAgent()` 在注册时补齐可选接口，
不支持的操作统一返回 `AGENT_FEATURE_UNSUPPORTED`，不借用其他厂商实现。
注册时检查必需对话能力以及已声明功能的实现，重复或未知标识直接报错。

Agent 的原生消息、状态、模型、用量和事件须转换为 `types.ts` / `events.ts` 中的中立 DTO。
平台负责权限、会话生命周期锁、分页、附件与输入关联、重试预算等业务规则；
原生 RPC、CLI 参数、日志格式和版本探测留在各 Agent 目录。重试适配器负责错误分类，并返回中立的执行状态、输入关联 ID 与是否已有结论，共用重试逻辑不读取原生消息类型。

## 两类宿主

- `terminal`：使用现有 PTY worker；实现自己的 CLI 命令和原生绑定。
  多行输入框、调整尺寸后是否重绘等行为由描述符声明，终端组件不识别厂商名。
  复合粘贴/回车操作共享同一终端输入锁。启动命令由父进程的适配器构造，PTY worker 接收最终命令，不为每个会话加载全套 Agent 实现；父进程注册的 CLI 适配器也无需在子进程重复注册。
- `managed`：直接连接 SDK 或远程服务；不创建 PTY、不要求 CLI 命令或本地日志文件。
  `launch.prepare()` 创建或恢复原生会话，首次启动的任务由实现明确提交。
  `host.ts` 只附着已有原生标识；浏览器重连和订阅不会创建会话或重发任务。
  同一原生会话与凭据范围共享事件连接，浏览器退出后宿主订阅仍可接收状态；服务关闭时释放连接。

`history.read()` 支持服务端分页；`history.file` 是可选的本地文件策略。
提供 SDK/HTTP 历史的 Agent 无须伪造 rollout 路径、UUID 或本地 JSONL。
原生会话标识允许不透明字符串。

## 新增服务型 Agent 的最小结构

```ts
import {registerAgent} from './registry.js';
import {capabilities, type AgentDefinition} from './types.js';

const adapter: AgentDefinition = {
  descriptor: {
    id: 'example_agent', label: 'Example Agent', sessionHost: 'managed',
    presentation: {icon: 'agent', color: '#64748b'},
    capabilities: capabilities(['history', 'runtime', 'input', 'stream', 'launch', 'resume']),
  },
  history: {read: (context, query) => transport.history(context.nativeId, query)},
  runtime: {read: context => transport.runtime(context.nativeId)},
  input: {submit: (context, text, clientId, attachments) =>
    transport.submit(context.nativeId, {text, clientId, attachments})},
  stream: {observe: (context, emit, onFailure) =>
    transport.observe(context.nativeId, emit, onFailure)},
  launch: {prepare: (context, task, instructions, resume) =>
    transport.prepare({context, task, instructions, resume})},
};
registerAgent(adapter);
```

示例中的 `transport` 是该 Agent 自己的实现，负责认证、原生事件转换和连接管理。
`observe()` 返回可调用的取消订阅函数，函数附带 `respond(id, answer)`。
未声明问题交互的 Agent 可以在该方法中报告不支持。
`submit()` 的 `false` 表示未接受；终端宿主可使用平台的 PTY 后备通道，服务宿主明确拒绝。
网络超时等模糊失败应抛错，不能返回 `false` 触发重复发送。

## 实时流与回答的扩展规则

- 注册时统一包裹 `sharedAgentStream()`，负责订阅复用、重放和连接失败的退避恢复。
  复用键包含原生标识与凭据范围；多租户或多端点适配器通过 `stream.scope(context)`
  明确隔离。平台 API 在每条消息上继续检查权限并应用个人忽略偏好。
- 适配器输出 `AgentStreamFrame`。初始附着和新轮次发送 `snapshot`；正文增量使用
  `patch.deltas`，消息完成使用 `patch.upserts`，执行状态使用 `patch.state`。
  偏移采用 JavaScript UTF-16 字符串长度。空消息开始事件可以省略，但首次可见正文必须
  通过 upsert 建立消息；状态与结束事件立即刷新，纯文字允许小批量合并。
- `stream_id` / `stream_seq` 由共享层维护，版本 2 的浏览器据此发现丢帧。
  API 不得因重复用量等原因丢弃带序号的事件。恢复快照是历史前缀，不能覆盖已经收到的
  新正文、工具状态或完成事件。只关心状态的宿主和重试监控使用 `streamFormat: 'state'`。
- 原生初始化、观察和恢复只能重订阅，不得启动新会话或重发用户输入。
  `runtime.subscribe()` 必须独立于可选日志文件；健康文件观察器不轮询，缺失或失败时退避重建。
  浏览器失活检测使用单调时钟，与展示用的浏览器日期时间分开。
- 问题回答的公共结构为 `AgentQuestionAnswer`：`answers` 按问题 ID 分组，
  可选 `attachments` 使用同样的问题 ID。API 统一检查上传目录、文件类型、整组大小和权限，
  适配器映射原生格式。`respond()` 可以返回 Promise，平台等待其确认接受后才返回成功；
  失败不清除回答草稿。Codex 阻塞提问的文本协议以文件引用交付附件，异步提问走正常附件输入。
- UI 的问题编辑器复用主输入框的附件上传、预览、取消和重试能力，单独管理回答草稿；
  不按 Agent 名称选择组件，也不把主输入框草稿混入回答事务。

当前 Codex 队列展示保留 100 条上限，原生读取分为每页 4 条，并对页数和重复游标设限。
通知突发时只保留一个进行中的队列读取和一次补读。
发送前的历史关联确认、自动重试检查仍保留原有完整轮次读取；极长轮次仍可能遇到原生
2 MiB 响应限制。这些路径涉及重复执行保护，不能用不完整快照当作完整的幂等证据。
后续应通过持久提交记录或原生关联 ID 查询来替代，不能直接删掉校验或模糊失败后重发。

注册后，创建选项、图标/名称、状态、模型控件、额度入口和调度能力由服务端描述符驱动。
用户仍须具备相应项目和 Agent 的权限。新增 Agent 不自动扩大已有用户授权。

## 数据兼容

数据库版本 23 增加 `agent_id` 与 `native_session_id`，迁移时回填旧绑定。
`cli_type`、`codex_session_id`、`claude_session_id` 暂时保留，旧入口写入通过触发器同步。
新 Agent 不增加专属数据库列。原模块路径保留薄的导出兼容层，业务实现已迁入对应 Agent 目录。

旧会话兼容指保留平台会话 ID、原生绑定、历史及附件关联；恢复时继续同一原生对话。
不会为迁移清空历史，也不会因浏览器重连自动启动新的 CLI。

## 当前实现与验证边界

Codex 继续使用原有 app-server 流式通道、模型/推理控制、问题回答、统计、额度和重试实现。
Claude 接入同一套查询/控制/生命周期 API，支持原生历史事件更新、模型别名设置、压缩、新开、恢复和中断。
Claude 当前通过终端与已落盘历史同步，不能等同于 token 级 SDK 流式输出。
模型变更提交后标记待确认；缺失的累计用量、窗口和统计不编造。
Claude 尚未提供统一的问题交互、逐进展统计、自动重试或额度驱动，相应能力不展示为可用。
本次仅用文件夹具与模拟终端验证 Claude，没有安装或启动本机 Claude Code。

新增测试用第三种 Agent 验证独立历史格式、不透明 ID、统一 API/权限、服务宿主及共享连接；
同时回归 Codex 的增量流式、排队回答、模型/压缩控制、重载和结论区间统计。
不增加按 token 的轮询：使用事件/文件通知、合并状态推送、有界缓存和增量文件读取。

## DeepSeek Harness 的后续接入

官方提供 `dsh sdk`（stdio JSON-RPC）和 `dsh acp`（stdio ACP），以及 `dsh web`。
可在独立 Agent 目录实现上述服务宿主接口，保留平台内对话。
现有 `dsh web` 实例的认证、会话枚举和绑定协议仍需验证；本次未实现或部署 DSH 适配器。

官方资料：
[项目](https://github.com/deepseek-ai/deepseek-harness)、
[CLI 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)。
