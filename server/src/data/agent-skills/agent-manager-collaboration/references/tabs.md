# 查找和创建标签页

接口路径均相对于平台提供的协作 API 地址。`capabilities` 声明当前会话可使用的操作和限制。

## 查找现有标签页

`GET /tabs` 对应 `list-tabs`。结果包含 `tabs`，每个条目提供 `tab_id`、`name`、`agent_id`、`state` 和 `can_receive`。结果中的 `next_cursor` 非空时，按需读取下一页。

```sh
python3 scripts/platform_api.py list-tabs
python3 scripts/platform_api.py list-tabs --cursor "$next_cursor"
```

按名称和当前任务确认目标。名称重复时，结合 Agent 类型、状态和用户指定的角色确认，仍有歧义时向用户说明可选项。提交消息前使用条目里的 `tab_id`。

## 创建并交付任务

`POST /tabs` 对应 `create-tab`。需要指定 Agent、模型或账号时，先用 [配置分配](allocation.md) 查询这个项目可用的选项。名称使用有辨识度的任务或角色名，例如 Jira 工单号。下例假设查询结果允许使用 Codex。

```sh
request_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
python3 scripts/platform_api.py create-tab <<JSON
{
  "request_id": "$request_id",
  "name": "DBM-1234 排查",
  "execution": {"agent_id": "codex"},
  "initial_message": "排查 DBM-1234。复现并记录环境、证据和影响范围，完成后回传结论。"
}
JSON
```

- `request_id`、`name` 和 `execution.agent_id` 必填。`initial_message` 可省略，省略时创建空白标签页。首条任务也由平台附上发起方的 `source_tab_id`，接收方可用它回传。
- `execution` 可含 `environment_id`、`model_id`、`reasoning_effort` 和 `service_tier`。只有平台当前列为可选的配置才可指定。省略的字段采用平台默认值，返回结果应包含实际应用的配置。
- 用响应里的 `tab_id`、`launch_status`、`applied_execution` 和 `initial_message_status` 分别核对标签页、启动、配置和首条任务。启动状态可为 `ready`、`starting`、`rejected` 或 `unknown`。未提交首条任务时，其状态为 `null`。投递状态见 [消息投递](messages.md)。
- 已有 `tab_id` 且首条任务明确被拒绝时，解决原因后向这个标签页补发。明确拒绝的启动按错误类型处理，例如权限不足、配置不可用、达到标签页上限。启动或首条任务结果待确认时，用原请求 ID 查询。

```sh
python3 scripts/platform_api.py operation "$request_id"
```
