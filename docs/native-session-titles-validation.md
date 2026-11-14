# 原生会话标题验证

原独立验证分支 `fix/native-session-titles`；现已并入用量功能分支统一验证，最终结果见 [用量统计验证记录](usage-statistics-validation.md)。

- 使用 Codex `Thread.name` 与 `thread/name/updated.threadName`（通过本机 0.169.0 协议生成器核对）。
- 订阅与 API Engine 使用相同适配路径，原生身份按 Engine 隔离。
- `native_title` 是可选平台元数据，手动 `customLabel` 优先；缺少原生名称时保留自动名称。
- 原生名称变更以 `session.title` 事件使会话列表失效；没有变化时不重复广播。
- 自动名称冲突加后缀，自动去重不会将名称提升为手动名称。
- 原生标题保存为可恢复元数据，不改写用户的手动标签。

验证：

| 命令 | 结果 |
|---|---|
| `npm --prefix server test` | 136 文件、1062 通过、1 跳过 |
| `npm --prefix dashboard test` | 最后完整复测 103 文件、575 通过；此前并发负载下 ProjectSessionCreateDialog 超时，单独及完整复测均通过 |
| `npm --prefix server test -- --run tests/native-session-titles.test.ts tests/codex-streaming-upgrade.test.ts` | 5 通过，覆盖 API Engine、跨 Engine 隔离、手动名称优先、持久化更新 |
| `npm --prefix dashboard test -- --run tests/native-tab-titles.test.ts tests/project-session-state.test.ts` | 5 通过，覆盖名称唯一、手动名称、重复更新幂等 |
| `npm --prefix server run build` | 通过 |
| `npm --prefix dashboard run build` | 通过，存在大 chunk 提示 |

独立分支阶段未单独执行完整浏览器套件；合并后的完整浏览器结果统一记入用量统计验证记录。
