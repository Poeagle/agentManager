---
name: agent-docs
description: 在 Agent Manager 中查找 Agent、查看进展、按任务和额度分配执行配置、创建和交接任务、处理多来源请求并精准回传。适用于 Agent 间协作。
---

# Agent 协作

用平台提供的标签页身份操作当前用户在当前项目中的标签页。协作权限来自 Agent Manager 的会话授权，任务范围和分工来自用户要求、当前任务和项目约定。

## 开始协作

从本技能目录运行 `python3 scripts/platform_api.py capabilities`，调用 `GET /capabilities`。查看响应中的 `version`、`source_tab_id`、`project_id`、`operations` 和 `limits`；按 `operations` 返回的命令名选择操作。下文参考中的命令同样从这个目录运行。客户端通过平台注入的连接和会话凭据调用 API。将凭据留在运行时。遇到能力缺失、凭据失效或权限拒绝时，报告对应操作当前不可用。

按此次操作选择参考：

- **确认执行身份、权限及可用 API**：[平台身份与 API](references/access.md)。
- **查找标签页、看进展，或新建并交付首条任务**：[标签页操作](references/tabs.md)。
- **发给一个或多个标签页、查看收件箱，或回传进度与结果**：[消息投递](references/messages.md)。目标 ID 未知时，再读标签页操作的查找部分。
- **按难度、账号额度或时效选择执行配置**：[配置分配](references/allocation.md)。使用现有标签页投递时可以跳过。
- **选择协作方式、并行验收或批量处理多来源任务**：[Agent 协作](references/collaboration.md)。

## 核对结果

用名称定位标签页，用平台返回的 ID 操作。给接收方提供完成任务所需的范围、约束和可验证的交付物；只带与交接有关的上下文。完成或验收结果通过回传消息确认。接收方优先用原消息的 `message_id` 回传，平台据此选择最初的发送方。

每次创建或投递都保留一个唯一的 `request_id`。超时、连接中断或返回结果待确认时，用原 ID 查询操作状态。批量投递按目标逐条判断结果，只为明确被拒绝且已解决原因的目标发起新的请求。任务状态以接收方的回传为准。
