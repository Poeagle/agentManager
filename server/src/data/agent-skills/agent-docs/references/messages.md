# 发送消息与回传

## 投递

执行写命令前先生成并记录请求 ID。可以单独运行 `python3 -c 'import uuid; print(uuid.uuid4())'` 生成，然后将确认过的值传到执行命令的环境。这样即使发送命令没有返回，也能查询原请求。

`POST /messages` 对应 `send-message`。使用 [查找标签页](tabs.md#查找现有标签页) 返回的目标 ID。请求必填 `request_id`、非空且去重的 `target_tab_ids` 和 `text`。平台根据会话授权附上 `source_tab_id` 和唯一的 `message_id`，并将消息作为普通会话输入交付。接收方在会话卡片里看到来源标签页和正文。

| 直接投递方式 | 参数 | 使用场景与行为 |
|---|---|---|
| 即时投递 | 省略 `after_current_turn` 或设为 `false` | 紧急阻塞、重要纠正等需立即介入时使用。平台尝试立即提交，忙碌目标是否接收取决于 Agent 的能力和当前状态，以回执为准。 |
| 轮后投递 | `after_current_turn: true` | 普通追加任务、补充材料或可稍后处理的交接。目标空闲时直接开始，目标忙碌时进入原生队列，等待当前轮结束后接收。 |

轮后投递前先用 `list-tabs` 查看 `can_queue_follow_up`。队列不可用时，平台返回拒绝。忙碌目标的普通事项应等到空闲后再直接投递，只有经判断确实需要立即介入时才在它忙碌期间改成即时投递。

```sh
# request_id 使用执行命令前已生成并记录的 ID。
: "${request_id:?先生成并记录本次请求 ID}"
python3 - "$request_id" "$ui_tab_id" "$docs_tab_id" <<'PYTHON' |
import json, sys
request_id, *targets = sys.argv[1:]
print(json.dumps({
    "request_id": request_id,
    "target_tab_ids": targets,
    "intent": "task",
    "after_current_turn": True,
    "text": "以候选提交为准，按各自职责核对空结果与错误状态。完成全部检查后一次回传结论、证据和待处理项。共用环境冲突且自行处理无果时，告诉我需要协调的资源，先继续可独立完成的检查。",
}, ensure_ascii=False))
PYTHON
python3 scripts/platform_api.py send-message
```

不同目标需要不同内容时，分别发送并使用不同请求 ID。并行任务需要等齐汇总时，设置 `intent: "task"` 并附上 [`batch_id`](batches.md)。带其他 Agent 文件内容或日志时，只包含当前任务需要的证据。示例用轮后投递，需即时投递时省略该字段。

实际派工使用 `intent: "task"` 并先做[子标签核查](tabs.md#派工前核查)。Agent 间消息沿用「平台设置 → 发送保护」中适用于目标 Provider 的规则。命中提醒或自动规则时，若目标空闲且允许接续，平台在同一标签内自动简要压缩，保留旧对话。Codex 订阅额度确认为零或原生接口明确报告额度耗尽时，平台先整理历史，再切换到符合条件的账号。确认新会话并重新检查发送条件后，用同一消息 ID 继续投递一次。目标忙碌、有待回传任务、找不到有额度的账号或处理失败时，查看逐目标回执原因。批次中的普通回传仍即刻入箱，只有实际唤醒父标签时才检查发送保护。

## 查看收件箱并回传

`GET /inbox` 对应 `inbox`，按收件顺序返回近期协作消息。每条包含 `message_id`、`source_tab_id`、`source_label`、正文预览、投递状态和可选的原消息引用。要比较多个请求的范围时，按需用 `read-message` 读取已进入当前标签页队列的完整正文。标记为待确认的记录用于核对投递状态，等收到完整来信再开展任务。多项测试可以依次执行，也可以合并共同步骤。要为每个原消息分别保留结果和证据。

```sh
python3 scripts/platform_api.py inbox
python3 scripts/platform_api.py read-message -- "$original_message_id"
```

回复时使用 `send-message` 的 `reply_to`，填当前标签页收到的原 `message_id`。平台通过原消息定位发送方和批次，无须填写 `target_tab_ids` 或 `batch_id`。API 会拒绝引用其他标签页的来信。每项任务验收后用一次 `result` 请求回传。父 Agent 要求的进展或可稍后协调的阻塞用 `progress`，需立刻协调的阻塞用 `blocker`。保留工单号或其他交付物标识，方便对方汇总。轮后参数仅用于 `target_tab_ids` 直接投递。通过 `reply_to` 回传时，批次内普通消息立即入箱并集中通知，紧急阻塞会尝试提前唤醒父 Agent。批次外回复按即时方式投递。

平台观察到子 Agent 的原生提问、授权请求或执行报错时，将详情作为内部 `blocker` 写入直属父标签的收件箱。收到「有待协调事项」时，用提示中的 `message_id` 读完整内容。需要回复子 Agent 时引用该条消息。处理原则见[问题与报错如何上报](collaboration.md#问题与报错如何上报)。

```sh
# reply_request_id 使用回传前已生成并记录的新 ID。
: "${reply_request_id:?先生成并记录本次回传请求 ID}"
python3 - "$reply_request_id" "$original_message_id" <<'PYTHON' |
import json, sys
request_id, original_message_id = sys.argv[1:]
print(json.dumps({
    "request_id": request_id,
    "reply_to": original_message_id,
    "intent": "result",
    "text": "DBM-1234 验收通过。检查了窄屏与键盘操作，证据见本项目验收记录。",
}, ensure_ascii=False))
PYTHON
python3 scripts/platform_api.py send-message
```

## 解释每个目标的状态

批量响应的 `result.results` 按目标列出 `tab_id` 和 `status`。进入投递流程后附上 `message_id`，拒绝时可附原因。自动简要压缩后成功直接投递时，回执包含 `guard_action: "brief"`。早期的操作记录可能返回 `guard_action: "new"`。

| 状态 | 含义 |
|---|---|
| `accepted` | 收到 Agent 接收回执。 |
| `queued` | 追加消息已进入原生队列，等待当前轮结束。 |
| `submitted` | 已交给运行时，尚无 Agent 接收回执。 |
| `stored` | 批次回传已进入父标签页的收件箱，带来源和原任务引用。紧急阻塞另外返回 `wake_status`。 |
| `rejected` | 已确认未交付。查看该目标的原因。 |
| `unknown` | 交付结果待确认。保留原请求 ID。 |

收到权限、发送保护或目标会话变化错误时，按错误处理并重新确认目标。整批请求失败或超时时，也优先核对原操作。

## 核对操作

`GET /operations/{request_id}` 对应 `operation`。响应包含 `request_id`、操作状态 `pending` 或 `settled`，以及当前可确认的创建或逐目标投递结果。读取次数和保留窗口以能力响应为准。查本次回传使用本次已记录的请求 ID，填写 `reply_to` 使用收到的原消息 ID。查不到记录时保留不确定状态，避免再次创建或发送。

```sh
python3 scripts/platform_api.py operation -- "$request_id"
```

接收方的运行状态用于了解它是否空闲或正在执行。需要确认任务是否已做完时，以引用原消息的 `result` 和附带证据为准。消息正文建议见 [协作规范](collaboration.md#消息约定)。
