# Agent 接入架构

平台按功能组合接口，各 Agent 负责自己的协议和实现。注册入口为
`server/src/services/agents/index.ts`，纯注册表位于 `registry.ts`；注册表不引用具体厂商。

```mermaid
flowchart TB
  UI[对话、标签状态、模型设置、定时任务] --> API[平台 API：权限、会话锁、历史分页、附件]
  API --> Registry[Agent 注册表与能力描述]
  Registry --> Ports[按功能组合的接口]
  Ports --> Codex[Codex 适配器：app-server、rollout、CLI]
  Ports --> Claude[Claude 适配器：Agent SDK、原生历史]
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

文件策略可实现 `turnBoundary(record)`，返回原生日志中的轮次开始／结束标记。
通用字节索引用这些标记补齐未逐条携带轮次标识的消息，再按原生轮次与条目 ID
建立实时流和历史记录的一致身份；不按正文跨轮次去重，也不解析工具输出中的伪标记。
标记来自已有的有界增量读取，不为关联消息扫描全部历史。

Codex 的待答问题索引位于其适配器目录，与对话历史复用 `codexUserText` 和相同的原生记录大小规则。
图片的原生包装文本不能参与回答正文识别；带图片的用户记录使用有界的大记录通道，工具输出仍受小记录上限约束。
索引只保留问题和已回答 ID，不保留图片数据，避免对话中已回答、标签却持续提示待答的状态分歧。

终端宿主统一使用 UTF-8 tmux 客户端参数，新建、重连、接管及历史恢复使用同一规则。
服务环境没有语言设置时按系统补上 UTF-8 默认值，显式语言配置和环境变量白名单保持有效。

Codex TUI 对异步回答的识别要求严格的单段纯文字回包，带图片或文件的原生输入不能直接用于终端的问题消除。
Codex 适配器因此为终端客户端使用本地兼容通道：请求逐字节转发，模型输入、附件和原生历史不改动；
仅在已接收的用户消息回执及历史重放中投影可识别的回答标识，按问题 ID 清除对应项。
普通输入、工具输出、其他待答问题和排队但尚未接收的回答保持原语义。
回答编辑器的图片位置不能套用到 JSON 回包中，原生组装时把图片占位放在完整回包后。

兼容通道按原生引擎共享，替换终端本来的连接，不创建额外原生订阅或轮询。
它按需启动、与平台进程分离，平台重启不会因此中断终端；最后一个终端断开后闲置 60 秒自动退出。
消息转发受发送完成回调控制，避免无界排队。已有终端需要在当前任务结束后重载标签页才能接入；
平台不会为清理提示自动重启正在工作的 Agent。

Codex Engine 属于平台管理资源。默认 Engine 和各 Provider Engine 由 AgentManager
启动，Socket、PID、日志和启动元数据保存在数据库专属目录；Web 服务重启只重新验证并附着，
不会创建第二个所有者。生产启动会解除旧的 `com.ymchen.codex-engine*` launchd 作业，
保存的 Provider 路由优先于环境变量中的外部路由。模型目录在 Engine 启动时读取，
修改目录后由用户显式重启对应 Engine；共享原生 Engine 的重启入口必须说明会中断其会话。
测试和隔离预览通过 `AGENTMANAGER_MANAGE_CODEX_ENGINES=false` 或
`AGENTMANAGER_TAKEOVER_CODEX_LAUNCH_AGENTS=false` 避免接管真实进程。

Engine 设置分别读取单个 Provider 状态，Provider 卡片和设置页共享该 Provider 的查询键，
不同 Provider 之间不共享运行状态或操作状态。每页显示实际 argv，并允许设置无 shell 的
启动命令和每行一个的附加参数；参数保存后重启目标 Engine。主动启动、停止、重启和配置保存
通过 NDJSON 进度流返回校验、准备、启动、等待 socket、确认和清理等阶段，前端按阶段显示
进度条与历史步骤，只有目标 Provider 的缓存会更新。

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
  API 不得因重复用量等原因丢弃带序号的事件。持久历史恢复是前缀，不能覆盖已经收到的
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
  同一平台会话的所有输入位置共享上传/打包队列，避免多个回答框并行加载大目录；
  独立会话互不阻塞。排队任务可以移除，进行中的任务通过现有 AbortSignal 取消。
  纯进度变化不更新父表单的业务状态或重复写入草稿；就绪状态在显示前同步，
  草稿保留附件所在的文本位置。
- 问题卡片、待回答提醒和答案状态共用原生 ID 索引，正文增量不使索引失效。
  已确认的原生回答优先于旧排队副本；缺少 ID 的旧格式回答仍按因果顺序匹配。
  多问题分组只对重复 ID 去重，不能因局部已加载而丢弃整组的其他问题。

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
Claude 接入同一套查询/控制/生命周期 API，支持 SDK 结构化事件流、原生历史事件更新、模型别名设置、新开、恢复和中断。
Claude 的持久化历史与 Codex 一样通过通用有界文件索引分页；适配器只提供记录投影，
把助手记录中的文字与工具块转为统一消息，并把工具结果折叠回对应工具 ID。
实时 SDK 以助手 API 消息 ID 作为消息身份，工具块按工具 ID 更新，不使用逐 chunk UUID。
进程重启后的持久历史由通用读取接口恢复；实时观察只附着既有运行时，不重新发送输入。
工具块在会话界面内联显示；持久历史和实时事件使用同一消息 ID，重连不能产生重复结论。
Claude 桌面会话仍使用通用的项目授权、会话锁、输入关联和诊断；重启不会自动创建原生轮次。
模型变更提交后标记待确认；缺失的累计用量、窗口和统计不编造。
Claude 尚未提供统一的问题交互、逐进展统计、自动重试或额度驱动，相应能力不展示为可用。
验证使用临时目录中的 Claude JSONL 夹具和模拟 SDK 事件，没有使用真实凭据或启动本机 Claude Code。

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
