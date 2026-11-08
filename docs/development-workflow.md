# AgentManager 开发流程

本文件是 AgentManager 的仓库级开发流程规范。`AGENTS.md` 只作为 Agent 指令入口，具体流程以本文件为准。架构原则、Agent 接入、测试和界面要求见 [AGENTS.md](../AGENTS.md)。

## 工作区隔离

每个新功能、修复或独立验证任务必须从最新 `main` 创建自己的 worktree 和功能分支。主工作区与 `main` worktree 只用于同步和合并，不作为多个任务的共享开发目录。

```bash
git worktree add -b fix/example /path/to/agentManager-worktrees/example main
```

分支名应说明工作内容，例如 `fix/conversation-order` 或 `feat/agent-settings`。多个独立任务不能共用同一个功能分支或 worktree；后续任务从最新 `main` 重新创建。

开始任务时检查：

```bash
git worktree list
git status --short --branch
```

已有未提交改动必须保留，并确认它们属于当前 worktree 的任务。发现不同任务混在同一工作区时，先拆分或说明冲突，不能通过覆盖、丢弃或混入无关改动继续。

## 实现与验证

在任务 worktree 中完成实现、回归测试和必要文档更新。按影响范围运行测试、类型检查和构建；检查差异，确认没有无关修改、密钥、个人数据或生成产物。

Bug 修复应在能稳定复现问题的最低合理层添加测试。测试必须确定、隔离、可重复；不能依赖开发者数据库、真实账号、生产端口或线上服务。不能运行的检查必须说明原因和未覆盖风险。

## 合并与部署

验证通过后，通过代码审查或明确的合并流程把功能分支合入本地 `main`。验证失败时先修复，不以“稍后再测”作为合入依据。

合并后先确认 `main` 的 commit 和工作区状态，再从该 commit 构建和部署。只有用户明确要求时才推送、部署或改动远端状态。
