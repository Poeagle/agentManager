# 并行协作批次

一批是父标签页本轮要一起验收的任务。范围按委派消息确定。同一个子标签页接到两条独立委派时，这一批需要两项结论。

## 派发和封批

1. 执行 `open-batch`，传入新 `request_id` 和可选的 `timeout_seconds`。从 `result.batch_id` 取得批次 ID。等待时限自开批开始，默认 30 分钟，最大值见 `capabilities`。长任务按项目约定设置。
2. 用 `create-tab` 加 `initial_message` 或 `send-message` 加 `intent: "task"` 派发。每次请求用独立的 `request_id` 并带上同一个 `batch_id`。一次发给多个标签页，每个目标算一项。分别核对启动和投递回执。
3. 完成派发后执行 `seal-batch`。封批后停止接收新的委派。父标签页有与用户目标直接相关且未委派的工作时可以继续做，否则结束当前轮次，等平台通知。

```sh
python3 scripts/platform_api.py open-batch <<JSON
{"request_id":"$open_request_id","timeout_seconds":1800}
JSON

python3 scripts/platform_api.py send-message <<JSON
{"request_id":"$task_request_id","batch_id":"$batch_id","target_tab_ids":["$child_id"],"intent":"task","text":"复验这一项。回传结论、证据和未完成项。"}
JSON

python3 scripts/platform_api.py seal-batch --request-id="$seal_request_id" -- "$batch_id"
```

## 回传与汇总

子标签页用原任务的 `message_id` 作为 `reply_to`。普通进展和结果即时入箱。需要父标签页立刻介入时才用 `blocker`，平台会另外尝试即时通知。已确定无法完成的事项，用 `result` 写明缺失条件和未验证范围，让父标签页知道这项已有结论。

派发结束后，全部任务已有结果或明确投递失败时，平台唤醒父标签页一次。到了截止时间也会通知一次，尚无结论的任务仍列为待回传。过时回传依旧入箱，可按需读取。

```sh
python3 scripts/platform_api.py read-batch -- "$batch_id"
python3 scripts/platform_api.py read-message -- "$result_message_id"
```

`read-batch` 返回每项的委派 `message_id`、目标、状态和可用的 `result_message_id`。读取结果正文可核对来源及证据。若批次到期，按读到的状态汇报。若唤醒被拒绝或结果不明，用 `wake_status`、`wake_error` 及收件箱核对，避免重复派发。父标签页决定是否沿用子标签页追问或复验，收尾后再按授权关闭。
