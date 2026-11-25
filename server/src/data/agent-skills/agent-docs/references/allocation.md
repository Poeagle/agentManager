# 选择 Agent、模型、推理强度和账号

`GET /execution-options` 对应 `execution-options`。按需限定 `agent_id`，只有选择会受额度影响时才请求 `include_quota=true`。返回的每个执行环境包含 `agent_id`、`environment_id`、可用模型和显式默认值。模型列出 `model_id` 及支持的 `reasoning_efforts` 和 `service_tiers`。可用的额度信息包含状态 `status`、窗口 `windows`、采集时间 `observed_at` 和共享额度组 `group_id`。每个窗口可有 `remaining_percent` 和 `resets_at`。未知或不适用的字段由平台如实呈现。

```sh
python3 scripts/platform_api.py execution-options
python3 scripts/platform_api.py execution-options --agent-id codex --include-quota
```

1. **先应用约束。** 遵循用户指定和项目约定，例如指定模型、预算或保留给验收的账号。只挑选当前项目授权、当前可用的组合。
2. **按子任务选能力。** 明确、可逆的整理和复现工作选够用的模型与推理强度。跨模块排查、难度高或错误代价大的工作可升级模型或强度。时效和预算单独决定速度档位。
3. **按实际额度选账号。** 查同类窗口的剩余量和重置时间，并检查额度的采集时间及共享额度组。共享同一额度的两个账号按同一份余量判断。已耗尽、过期、无权读取和未知是不同状态。API 账号的余额和订阅账号的用量百分点遵循各自口径。额度未知时考虑授权默认配置，若预算要求依赖确定的额度，就暂停该项派发并说明缺少的读数。
4. **确认落地。** 用返回的 ID 构造新标签页的 `execution`，核对创建响应的 `applied_execution` 后再说明实际配置。现有标签页继续用它自己的配置执行。

配置字段示例。下面的 shell 变量应来自同一次发现结果。可选字段无确认值时使用空值。

```sh
# request_id 使用执行命令前已生成并记录的 ID。
: "${request_id:?先生成并记录本次请求 ID}"
python3 - "$request_id" "$agent_id" "$environment_id" "$model_id" "$reasoning_effort" "$service_tier" <<'PYTHON' |
import json, sys
request_id, *values = sys.argv[1:]
keys = ("agent_id", "environment_id", "model_id", "reasoning_effort", "service_tier")
print(json.dumps({
    "request_id": request_id,
    "name": "复杂问题根因排查",
    "execution": {key: value for key, value in zip(keys, values) if value},
}, ensure_ascii=False))
PYTHON
python3 scripts/platform_api.py create-tab
```

可选字段只有具备已确认的值才应加入。若用户明确要求的组合无法应用，报告不可用的字段和平台给出的选项。
