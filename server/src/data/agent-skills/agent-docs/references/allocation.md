# 在同一 Provider 内选择执行配置

## 已有子标签页

用 `tab-controls` 查询目标当前绑定的模型目录和执行设置。先从 `list-tabs --children` 确认目标。响应里的 `can_update` 标明当前标签页能否修改该直属子标签页，`supported` 标明可修改的参数。比较 `execution` 与 `pending_execution` 可以区分现有设置和待应用设置。

```sh
python3 scripts/platform_api.py list-tabs --children
python3 scripts/platform_api.py tab-controls -- "$target_tab_id"
# 仅当当前目标模型的 reasoning_efforts 含 max 时执行。
python3 scripts/platform_api.py update-tab-controls --request-id="$request_id" \
  --reasoning-effort max -- "$target_tab_id"
```

- `--model-id`、`--reasoning-effort`、`--service-tier` 可单独或组合提交。Fast 用模型目录公布的档位 ID，`default` 恢复默认档位。请用目录中的值解析用户说的「最高」或「Fast」。
- 省略参数时沿用原设置。换模型时，若原推理强度不可用，使用新模型默认强度；若现有速度档位不兼容，显式选择兼容档位再提交。Agent 类型、账号、Provider、标签 ID、原生会话和历史都保留。
- `applied` 表示运行时已接受设置，后续模型请求使用新设置，已发出的模型请求继续运行。Claude Harness 在下一次 SDK 查询启动时使用新模型。`saved` 表示等待恢复时应用，`submitted` 表示等待原生确认。用 `tab-controls` 查看最新设置。`unsupported` 表示该 Agent 无此能力，`rejected` 带具体原因，`unknown` 时查询原操作和当前设置。结果待确认时保留原会话，也保留原请求 ID。
- 一次修改多个子标签时，逐个查询，每个目标使用独立请求 ID，并汇总实际回执。先核对设置，再按用户要求继续派单。

HTTP 接口是 `GET /tabs/{tab_id}/controls` 和 `POST /tabs/{tab_id}/controls`。写请求包含 `request_id` 和 `execution`，后者接受 `model_id`、`reasoning_effort` 和 `service_tier`。回执与权限范围详见 [平台身份与 API](access.md)。

## 新建子标签页

**子标签页沿用创建者的 Agent 类型、Provider 和账号。** 创建时通常省略 `execution`。遇到额度不足或绑定不可用时报告阻塞，保持本次派发的 Provider 和账号不变。

需要为具体子任务选择模型、推理强度或速度档位时，调用 `execution-options`。响应的 `source_execution` 报告当前标签页的 `agent_id` 和 `environment_id`；`environments` 只包含该环境可用的选项。每个模型列出 `model_id`、`reasoning_efforts` 和 `service_tiers`。查询失败或选项为空时，以创建回执确认可用性。

```sh
python3 scripts/platform_api.py execution-options
python3 scripts/platform_api.py execution-options --include-quota
```

- 明确、可逆的整理或复现工作选够用的模型与强度。跨模块排查或错误代价高的工作可在当前 Provider 内提高模型或强度。速度档位按用户给出的时效和预算选择。
- 额度影响派发时，查看该账号的 `status`、`observed_at`、`windows` 中的 `remaining_percent` 和 `resets_at`。额度读数未知且预算要求明确时，报告缺少的读数。
- 发送创建请求后，用回执的 `applied_execution` 核对绑定和模型。

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
