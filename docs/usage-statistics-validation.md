# 用量统计调整验证记录

本记录对应独立分支 `feat/usage-period-csv`；未合入、未部署。

## 计算与存储验证

- 按小时、日、周、月独立分配；筛选不重新分配隐藏项；四位小数最大余数分配守恒。
- 覆盖午夜、跨年/月/周、时区及夏令时重复小时、等价 UTC 时间表示、未知值和零分母。
- CSV 覆盖转义、原子切换、重启、跨日归档、校验损坏、上一代恢复、旧缓存转换、状态检查点及采样过期。
- SQLite 原始采集和去重索引保留作兼容与恢复来源；生产库尚未执行迁移。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `npm --prefix server test` | 最近完整运行 1070 通过，1 跳过；随后修改的相关模块另跑定向回归 |
| `npm --prefix dashboard test` | 最近完整运行 572 通过；随后增加的边界测试定向通过 |
| `npm run test:update-security` | 5 通过 |
| `npm --prefix server run build` | 通过 |
| `npm --prefix dashboard run build` | 通过，存在既有大 chunk 提示 |
| `npm exec playwright test -- --config playwright.usage.config.ts` | 用量专项通过，覆盖小时/日/周/月切换、展开与搜索 |
| `npm run test:e2e` | 64 项完整执行：39 通过、25 失败；用量专项包含在通过项中 |

## 完整浏览器套件失败清单

以下为该次完整运行的实际错误，未断言所有问题均为本次改动引入或均为基线问题。两个已修正的旧 UI 断言另行复测。

| 用例 | 实际错误摘要 |
|---|---|
| `platform-rbac.spec.ts:4` Platform management provides role configuration and enforces a monitoring-only account | Error: expect(locator).toBeVisible() failed; Locator: getByRole('dialog', { name: '平台管理' }).getByRole('navigation', { name: '平台管理分类' }).getByRole('button', { name: '用户管理', exact: true }); Expected: visible; Error: element(s) not found |
| `platform-rbac.spec.ts:59` Project ownership, client selection and monitoring all use compact expandable tables | Test timeout of 90000ms exceeded. Error: apiRequestContext.delete: Test timeout of 90000ms exceeded. |
| `agent-management.spec.ts:3` shows Agent-specific settings for Codex and Claude | Error: expect(locator).toBeVisible() failed; Locator: getByRole('heading', { name: 'Agent 配置' }); Expected: visible; Error: element(s) not found |
| `codex-environments.spec.ts:91` switches from account Providers to native and API Providers without becoming stuck or inventing unsaved changes | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: 'Codex 账号 Provider' }).getByText('授权用户', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-activity.spec.ts:6` one-line tool activity scrolls, keeps real timers and never enters public conversation messages | Error: expect(locator).toContainText(expected) failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByTestId('conversation-activity-line') |
| `conversation-clock.spec.ts:8` progress uses the browser clock across reload, shows completion metadata and aligns with its number | Error: expect(locator).toHaveText(expected) failed; Locator:  getByRole('region', { name: '会话对话' }).filter({ visible: true }).locator('[data-chat-message-id="live-time"]').locator('.session-chat-message-statistics'); Expected: "token: ≥500 · tools: ≥2/≥1"; Received: "token: ≥500 · tools: ≥2｜≥1" |
| `conversation-controls.spec.ts:7` model controls use native capabilities and a docked file stays readable while feedback is sent | Error: expect(locator).toBeVisible() failed; Locator: getByText('上下文 30%', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-errors.spec.ts:7` native failures appear live, stop busy indicators and survive history reconciliation and reload | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('执行验证任务', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-implicit-final.spec.ts:7` renders an unphased Codex completion as the conclusion across reload | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('事件通道已连接', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-interactions.spec.ts:10` native questions and approvals survive refresh and submit through the actual authenticated bridge | Error: expect(locator).toBeVisible() failed; Locator: getByText('事件通道已连接').filter({ visible: true }); Expected: visible; Error: element(s) not found |
| `conversation-legacy-identity.spec.ts:7` legacy rollout echoes reconcile live conclusions once across turns, tab switches and reload | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('事件通道已连接', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-order.spec.ts:7` sending, early native echoes, late history and reload preserve causal message order | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('事件通道已连接'); Expected: visible; Error: element(s) not found |
| `conversation-reading.spec.ts:6` conversation shares its tab row, resizes, previews and navigates rich streamed content | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('事件通道已连接', { exact: true }); Expected: visible; Error: element(s) not found |
| `conversation-reload.spec.ts:8` reload preserves the same conversation, draft and atomic picture text while replacing only its client | Test timeout of 45000ms exceeded. Error: apiRequestContext.delete: Test timeout of 45000ms exceeded. |
| `conversation-statistics-duplicates.spec.ts:6` deduplicates native conclusion echoes and shows actual usage and duration after reload | Error: expect(locator).toHaveCount(expected) failed; Locator:  getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('测试结论', { exact: true }); Expected: 1; Received: 0 |
| `conversation-streaming.spec.ts:7` renders each native delta before the item completes and keeps one progress bubble | Error: listen EADDRINUSE: address already in use /home/xlli/.codex/worktrees/usage-period-csv/.test-data/e2e/codex.sock |
| `conversation-view.spec.ts:11` chat hides tool logs, sends to the same live session and switches to its original terminal | Error: listen EADDRINUSE: address already in use /home/xlli/.codex/worktrees/usage-period-csv/.test-data/e2e/codex.sock |
| `platform-ai.spec.ts:9` Platform AI chats through real platform tools and a signed external gateway | TypeError: Cannot read properties of undefined (reading 'some')    105 \|     expect(modelRequests.length).toBe(2);   106 \|     const tool=JSON.parse(modelRequests[1].messages.find((message: any) => message.role==='tool') |
| `previews.spec.ts:32` previews diagrams, tables, images, PDF, and readable wrapped text locally | TypeError: Cannot read properties of undefined (reading 'id')    50 \|   await page.request.put('/api/settings', { data: { settings: { statusline_prompted: 'true' } } });   51 \|   await page.request.put('/api/user-state/a |
| `progress-intervals.spec.ts:6` progress badges and folding keep metadata separate from the message content | Error: expect(locator).toBeVisible() failed; Locator: getByRole('region', { name: '会话对话' }).filter({ visible: true }).getByText('step · token: 100 · tools: 1 call / 1 round', { exact: true }); Expected: visible; Error: element(s) not found |
| `prompt-enhancement-copy.spec.ts:20` copying an enhanced prompt keeps the preview open and never writes to the terminal | Test timeout of 45000ms exceeded. Error: locator.click: Test timeout of 45000ms exceeded. |
| `question-terminal-sync.spec.ts:8` an attached answer clears only its native terminal question and stays resolved after replay | Error: listen EADDRINUSE: address already in use /home/xlli/.codex/worktrees/usage-period-csv/.test-data/e2e/codex.sock |
| `scheduled-windows.spec.ts:5` aligns host telemetry and separates scheduled task display from daily window settings | Test timeout of 45000ms exceeded. Error: locator.boundingBox: Test timeout of 45000ms exceeded. |
| `session-resume.spec.ts:52` Resume shows failure, immediate retry feedback, and progress until terminal readiness | Error: expect(locator).toContainText(expected) failed; Locator: getByRole('alert'); Error: strict mode violation: getByRole('alert') resolved to 2 elements: |
| `table-consistency.spec.ts:70` all platform lists and expanded lists retain the same table structure | Test timeout of 45000ms exceeded. Error: locator.click: Test timeout of 45000ms exceeded. |

## 合成性能样本

- 100000 请求转为小时 CSV，首次测得约 629 ms，归档总 Token 校验一致。
- 300000 请求、5000 额度采样，首次测得计算约 687 ms。
- 均为本机合成数据，包含测试进程和负载差异，不作为生产延迟保证。

## 最终复核补充

- 最后一轮完整服务端：137 文件通过，1071 用例通过，1 用例跳过。
- 最后一轮完整前端：102 文件通过，574 用例通过。随后新增的提示隐藏回归单独通过（账户详情 13 项）。
- 两个旧界面断言修复后分别复测通过：`agent-management.spec.ts` 和 `codex-environments.spec.ts` 的 Provider 切换用例。完整运行本身仍记录为 39 通过、25 失败，未将定向复测混算为一次全绿运行。
- 完整浏览器剩余失败未在本次用量统计改动中解决，范围和原始错误见上表；不能宣称全套浏览器通过。
- SQLite 的采集和去重索引保留，CSV 已接入正常日／小时读取。尚未合入／部署，因此现有运行实例的生产库与文件没有被本分支转换。
- 每轮只更新当天或跨天需收尾的日期；历史文件按内容哈希复用。跨多日停机恢复执行有界全量补采并去重。
- 用户要求隐藏的“历史部分记录不可读取；已核对的数据已按新规则更新”说明已移除，相关组件回归通过。

## API Engine 兼容复核

`npm --prefix server test -- --run tests/codex-usage-csv.test.ts tests/codex-account-usage.test.ts tests/codex-environments.test.ts tests/codex-environment-usage.test.ts tests/codex-engine-balance.test.ts`：5 文件、64 项通过。覆盖 API 历史归属、共享目录保护、跨 Engine 请求去重、上游余额，以及 CSV 中 Provider、模型和速度元数据保留。API 钱包实际扣费仍来自上游，订阅周额度公式不用于 API 钱包。
