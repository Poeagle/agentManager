# 发送消息与回传

## 投递

`POST /messages` 对应 `send-message`。使用 [查找标签页](tabs.md#查找现有标签页) 返回的目标 ID。请求必填 `request_id`、非空且去重的 `target_tab_ids` 和 `text`。平台根据会话授权附上发送方 ID，并将消息作为普通会话输入交付。

```sh
request_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
python3 - "$request_id" "$ui_tab_id" "$docs_tab_id" <<'PYTHON' |
import json, sys
request_id, *targets = sys.argv[1:]
print(json.dumps({
    "request_id": request_id,
    "target_tab_ids": targets,
    "text": "功能已完成并通过自验。请按各自职责核对改动，回传结论、证据和待处理项。",
}, ensure_ascii=False))
PYTHON
python3 scripts/platform_api.py send-message
```

不同目标需要不同内容时，分别发送并使用不同请求 ID。回传进度、问题或结果也使用这个接口，目标填来信中由平台附上的 `source_tab_id`。保留工单号或必要的交付物标识，有助于对方匹配任务。根据任务要求决定是否回传和转交。

## 解释每个目标的状态

批量响应包含 `results`，每条结果带 `tab_id`、`status`，可附错误代码和原因。

| 状态 | 含义 |
|---|---|
| `accepted` | 收到 Agent 接收回执。 |
| `queued` | 平台或原生 Agent 已接受排队。 |
| `submitted` | 已交给运行时，尚无 Agent 接收回执。 |
| `rejected` | 已确认未交付。查看该目标的原因。 |
| `unknown` | 交付结果待确认。保留原请求 ID。 |

收到权限、发送保护或目标会话变化错误时，按错误处理并重新确认目标。整批请求失败或超时时，也优先核对原操作。

## 核对操作

`GET /operations/{request_id}` 对应 `operation`。响应包含 `request_id`、操作状态 `pending` 或 `settled`，以及当前可确认的创建或逐目标投递结果。读取次数和保留窗口以能力响应为准。查不到记录时保留不确定状态，避免再次创建或发送。

```sh
python3 scripts/platform_api.py operation "$request_id"
```
