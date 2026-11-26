# 在同一 Provider 内选择执行配置

## 派工上限

- Codex 子标签页的模型上限是 `gpt-6.2-sol`，`gpt-6.2-astra` 超出上限。推理强度最高 `high`，其中 `gpt-6-luna` 在当前 Provider 支持时可以用到 `max`。简单任务选择够用的较低档模型或强度。模型档次无法确认时，选择已知符合上限的模型。
- 子标签页以标准速度执行。提供速度档位时，显式使用 `service_tier: "default"` 关闭 Fast。创建者的模型、推理强度或速度设置超出派工上限时，显式指定合规配置。
- 尽量复用已有子标签页。新建和复用都在派工前核对配置。同一 Provider 或账号找不到确认符合要求的配置时，报告受阻。

## 已有子标签页

用 `tab-controls` 查询目标当前绑定的模型目录和执行设置。先从 `list-tabs --children` 确认目标。响应里的 `can_update` 标明当前标签页能否修改该直属子标签页，`supported` 标明可修改的参数。比较 `execution` 与 `pending_execution` 可以区分现有设置和待应用设置。

```sh
python3 scripts/platform_api.py list-tabs --children
python3 scripts/platform_api.py tab-controls -- "$target_tab_id"
# 确认目标目录支持此组合后，按派工上限原地更新。
python3 scripts/platform_api.py update-tab-controls --request-id="$request_id" \
  --model-id gpt-6.2-sol --reasoning-effort high --service-tier default -- "$target_tab_id"
```

- `--model-id`、`--reasoning-effort`、`--service-tier` 可单独或组合提交。复用时发现当前配置或将应用的配置超出上限，先调整，再用 `tab-controls` 核对生效的设置后派工。
- 省略参数时沿用原设置。换模型时，在 Agent 支持的字段中显式指定合规的推理强度和标准速度档位，避免新模型的默认设置超出上限。Agent 类型、账号、Provider、标签 ID、原生会话和历史都保留。
- `applied` 表示运行时已接受设置，后续模型请求使用新设置，已发出的模型请求继续运行。Claude Harness 在下一次 SDK 查询启动时使用新模型。`saved` 表示等待恢复时应用，`submitted` 表示等待原生确认。用 `tab-controls` 查看最新设置。`unsupported` 表示该 Agent 无此能力，`rejected` 带具体原因，`unknown` 时查询原操作和当前设置。结果待确认时保留原会话，也保留原请求 ID。
- 一次修改多个子标签时，逐个查询，每个目标使用独立请求 ID，并汇总实际回执。先核对设置，再按用户要求继续派单。

HTTP 接口是 `GET /tabs/{tab_id}/controls` 和 `POST /tabs/{tab_id}/controls`。写请求包含 `request_id` 和 `execution`，后者接受 `model_id`、`reasoning_effort` 和 `service_tier`。回执与权限范围详见 [平台身份与 API](access.md)。

## 新建子标签页

**子标签页沿用创建者的 Agent 类型、Provider 和账号。** 新建 Codex 子标签页时显式填写 `execution`，指定合规的模型、推理强度与标准速度。遇到额度不足或绑定不可用时报告阻塞，保持本次派发的 Provider 和账号不变。

先调用 `execution-options` 核对可用配置。响应的 `source_execution` 报告当前标签页的 `agent_id` 和 `environment_id`，`environments` 只包含该环境可用的选项。每个模型列出 `model_id`、`reasoning_efforts` 和 `service_tiers`。

```sh
python3 scripts/platform_api.py execution-options
python3 scripts/platform_api.py execution-options --include-quota
```

- 额度影响派发时，查看该账号的 `status`、`observed_at`、`windows` 中的 `remaining_percent` 和 `resets_at`。额度读数未知且预算要求明确时，报告缺少的读数。
- 发送创建请求后，用回执的 `applied_execution` 核对绑定、模型、推理强度和速度。只有配置确认符合要求后才继续派工。

例如，复杂的 Codex 排查任务可在确认当前 Provider 支持后使用上限配置。较简单的任务按可用选项下调模型或推理强度。

```sh
: "${request_id:?先生成并记录本次请求 ID}"
python3 scripts/platform_api.py create-tab <<JSON
{
  "request_id": "$request_id",
  "name": "复杂问题根因排查",
  "execution": {"model_id": "gpt-6.2-sol", "reasoning_effort": "high", "service_tier": "default"}
}
JSON
```

选择 Luna 且任务需要 `max` 时，确认当前 Provider 支持后使用以下 `execution`。复用已有子标签页时可按同一组合原地更新。

```json
{"model_id": "gpt-6-luna", "reasoning_effort": "max", "service_tier": "default"}
```
