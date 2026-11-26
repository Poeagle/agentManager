# 标签页生命周期

接口路径均相对于平台提供的协作 API 地址。`capabilities` 声明当前会话可使用的操作和限制。

## 查找现有标签页

`GET /tabs` 对应 `list-tabs`。结果包含 `tabs`，每个条目提供 `tab_id`、`name`、`agent_id`、`state`、`can_receive`、`can_queue_follow_up`、`can_delete` 和 `parent_tab_id`。默认查找活跃标签页。用 `--children` 只查当前标签页创建的直属子标签，可与 `--include-ended` 一起使用。用 `--include-ended` 同时查找已经结束的标签页，适合按名称定位要清理的历史会话。直接由用户创建的标签页其父级为空。子标签页的 `parent_tab_id` 指向创建者，关闭父级后这个 ID 仍保留。结果中的 `next_cursor` 非空时，按需读取下一页。

```sh
python3 scripts/platform_api.py list-tabs
python3 scripts/platform_api.py list-tabs --children
python3 scripts/platform_api.py list-tabs --cursor "$next_cursor"
python3 scripts/platform_api.py list-tabs --include-ended
```

按名称和当前任务确认目标。名称重复时，结合 Agent 类型、状态和用户指定的角色确认，仍有歧义时向用户说明可选项。提交消息前使用条目里的 `tab_id`。

## 派工前核查

派工或开批前先用 `list-tabs --children --include-ended`，按 `next_cursor` 查完直属子标签。先按角色、任务依据和当前状态找适合复用的标签，有需要再改模型参数。忙碌但适合接续的标签可以按能力安排轮后投递。只有找不到合适标签时才新建，新一批任务也可以沿用上一批的标签。

`cleanup_review` 包含父标签发出的 `task_message_id` 和收到的 `result_message_id`，表示在近期可核对的派工记录中已有结果且无待回传任务。也会提示仍显示在项目中的已结束标签。用 `read-message` 核对结果；需要确认是否仍在做其他工作时用 `read-tab`。核查后按用途处理：

- **沿用。** 按[派工上限](allocation.md#派工上限)核对匹配标签的设置后派工，它是本次目标，无须另行列为保留。
- **关闭。** 已验收、无后续工作且具备权限时，用默认的 `delete-tab` 关闭并保留历史。
- **保留。** 仍需待命、承担其他职责，或状态有待核实的标签继续保留。在本次派工或创建 JSON 的 `retain_child_tab_ids` 中填写已核查且需保留的 ID。

创建标签或通过 `intent: "task"` 直接派工前，服务端会重查。若还有候选未处理，返回 HTTP 409，`code: "child_cleanup_required"`、`state: "not_started"` 和 `cleanup_candidates`。本次尚未创建标签、投递消息或登记批次任务。按响应逐个核对，处理完可使用原 `request_id` 重新提交。若 `more_cleanup_candidates` 为真，按原列表分页继续核查。同批已分配的标签留到本批收尾时处理。

## 读取进展

用 `GET /tabs/{tab_id}` 读取某个标签页的状态和少量近期用户与 Agent 消息。只在需要核对具体进度时调用。返回的历史节选用于了解当前工作，任务的验收结论仍由执行方回传。

```sh
python3 scripts/platform_api.py read-tab -- "$target_tab_id"
```

## 继续原会话

回传后需要补证据或复验时，用原标签派发跟进任务。运行中的子标签有队列能力时，可用 [轮后派发](messages.md#投递) 把跟进安排在当前轮结束后。需要调整模型、推理强度或 Fast 时，使用 [原地更新](allocation.md#已有子标签页)。

收到原生交互阻塞后，若该轮次无法继续，可以停止直属子标签的对应轮次。`stop-child-turn` 调用 `POST /tabs/{tab_id}/stop`，使用同一条内部阻塞消息里的原生会话 ID 和执行轮次 ID。回执 `accepted` 表示停止请求已受理，用 `read-tab` 确认执行已停止后再派发。结果待确认时，用原请求 ID 查询。

```sh
python3 scripts/platform_api.py stop-child-turn --request-id="$request_id" \
  --native-id="$native_id" --turn-id="$turn_id" -- "$child_tab_id"
```

## 创建并交付任务

`POST /tabs` 对应 `create-tab`。新标签页继承创建者的 Agent 类型、Provider 和账号。先按[派工前核查](#派工前核查)确认暂无合适的已有标签，再按[派工上限](allocation.md#派工上限)在同一 Provider 内选配置。用有辨识度的任务或角色命名，例如 Jira 工单号。

```sh
# Codex 示例。先确认当前 Provider 支持所列配置。
: "${request_id:?先生成并记录本次请求 ID}"
python3 scripts/platform_api.py create-tab <<JSON
{
  "request_id": "$request_id",
  "name": "DBM-1234 排查",
  "execution": {"model_id": "gpt-6.2-sol", "reasoning_effort": "high", "service_tier": "default"},
  "initial_message": "排查 DBM-1234。复现并记录环境、证据和影响范围，完成后回传结论。"
}
JSON
```

- `request_id` 和 `name` 必填。`initial_message` 可省略，省略时创建空白标签页。首条任务附有平台生成的 `message_id` 与发起方 `source_tab_id`。接收方用原 `message_id` 作为 `reply_to`。
- 首条任务属于 [并行协作批次](batches.md)时，同时提交 `initial_message` 和 `batch_id`。
- 创建 Codex 子标签页时，通过 `execution` 显式填写符合派工上限的 `model_id`、`reasoning_effort` 和 `service_tier`。其他 Agent 按当前 Provider 提供的能力填写。若请求仍带 `agent_id` 或 `environment_id`，其值必须与创建者匹配，平台会拒绝跨 Provider 或跨账号的创建。
- 用响应 `result` 里的 `tab_id`、`launch_status`、`applied_execution` 和 `initial_message_status` 分别核对标签页、启动、配置和首条任务。返回的 `parent_tab_id` 为本次创建者。启动状态可为 `ready`、`starting`、`rejected` 或 `unknown`。未提交首条任务时，其状态为 `null`。已进入投递流程的首条任务带有 `initial_message_id`。投递状态见 [消息投递](messages.md)。
- 已有 `tab_id` 且首条任务明确被拒绝时，解决原因后向这个标签页补发。明确拒绝的启动按错误类型处理，例如权限不足、配置不可用、达到标签页上限。启动或首条任务结果待确认时，用原请求 ID 查询。

```sh
python3 scripts/platform_api.py operation -- "$request_id"
```

## 关闭或删除标签页

`POST /tabs/{tab_id}/delete` 对应 `delete-tab`。根据用户或项目授权确认目标，优先用 `list-tabs --include-ended` 核对名称、ID、父级与 `can_delete`。接口处理当前用户在当前项目中有权操作的其他标签页。关闭会结束目标标签正在进行的工作。每次只处理指定标签页。

子标签回传结果后，由父标签验收并决定是否关闭。需要追问、复验，或还有该标签页正在处理的其他请求时，保留标签页继续协作。详情见[多轮跟进与关闭](collaboration.md#多轮跟进与关闭)。

```sh
python3 scripts/platform_api.py delete-tab --request-id="$request_id" -- "$target_tab_id"
```

- 默认关闭标签页并保留会话历史。回执显示 `status: "closed"` 和 `history_status: "retained"`，用户可以从项目历史找回。
- 用户明确要求永久删除历史时，加 `--delete-history`，对应 JSON 参数 `delete_history: true`。收到 `history_status: "pending"` 表示标签已关闭且清理已排队，此时外层操作可已是 `state: "settled"`。用 `operation` 查询到 `deleted` 后再报告已永久删除。出现 `failed` 时报告清理失败和保留的记录，出现 `unknown` 时保留原请求并核对状态。
- 父标签关闭或永久删除后，其子标签继续工作。在导航中仍打开的子标签会移到项目这一层，并保留创建来源标记。需要清理多个标签时，逐个核对并提交各自的 ID。
