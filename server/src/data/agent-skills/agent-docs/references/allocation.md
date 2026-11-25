# 在同一 Provider 内选择执行配置

**子标签页沿用创建者的 Agent 类型、Provider 和账号。** 创建时通常省略 `execution`。遇到额度不足或绑定不可用时报告阻塞，保持本次派发的 Provider 和账号不变。

需要为具体子任务选择模型、推理强度或速度档位时，调用 `execution-options`。响应的 `source_execution` 报告当前标签页的 `agent_id` 和 `environment_id`；`environments` 只包含该环境可用的选项。每个模型列出 `model_id`、`reasoning_efforts` 和 `service_tiers`。查询失败或选项为空时，以创建回执确认可用性。

```sh
python3 scripts/platform_api.py execution-options
python3 scripts/platform_api.py execution-options --include-quota
```

- 明确、可逆的整理或复现工作选够用的模型与强度。跨模块排查或错误代价高的工作可在当前 Provider 内提高模型或强度。速度档位按用户给出的时效和预算选择。
- 额度影响派发时，查看该账号的 `status`、`observed_at`、`windows` 中的 `remaining_percent` 和 `resets_at`。额度读数未知且预算要求明确时，报告缺少的读数。
- 发送创建请求后，用回执的 `applied_execution` 核对绑定和模型。已有标签页继续用其自身配置执行。

要使用查询得到的模型，可以在创建请求的 `execution` 中只填 `model_id`，按需加上受支持的 `reasoning_effort` 或 `service_tier`。下面的变量应来自实际执行选项。

```sh
: "${request_id:?先生成并记录本次请求 ID}"
: "${model_id:?先查询同一 Provider 的可用模型}"
python3 - "$request_id" "$model_id" <<'PYTHON' | python3 scripts/platform_api.py create-tab
import json, sys
request_id, model_id = sys.argv[1:]
print(json.dumps({
    "request_id": request_id,
    "name": "复杂问题根因排查",
    "execution": {"model_id": model_id},
}, ensure_ascii=False))
PYTHON
```
