# DeepSeek Harness 网页标签

OctoAlly 可以从项目列表的「打开」和项目内的「＋」打开 DeepSeek Harness 标签。标签使用 Harness 原版网页。首次打开时，Harness 将 OctoAlly 已授权项目的目录注册为工作区，或复用同目录的现有工作区，然后打开其中的对话。每个项目有一个 Harness 标签，同一浏览器刷新后会恢复标签。已经打开的标签在切换项目时保留网页状态，关闭标签不会删除 Harness 的工作区或对话。

在项目内的会话标签栏拖动 Harness 标签可调整顺序。双击标签名称，或在标签获得键盘焦点时按 `F2`，即可重命名。名称和位置按项目保存在当前浏览器，刷新后会恢复。

```mermaid
sequenceDiagram
    participant O as OctoAlly 项目标签
    participant H as Harness 网页
    participant D as Harness 工作区
    O->>H: 验证来源与连接
    H-->>O: 已登录且工作区列表就绪
    O->>H: 打开当前项目目录
    H->>D: 复用或注册同目录工作区
    D-->>H: 工作区 ID
    H->>H: 打开工作区的对话
    H-->>O: 工作区已打开
```

## 配置 Harness 实例

插件按 DeepSeek Harness `0.2.2-rc.5` 开发。Web 实例需要可从浏览器访问，且能以自身运行账号读取项目的同一绝对路径。远程实例可以通过共享挂载提供相同的路径。本次接入使用原版 Harness 侧栏和权限，Harness 账号可以看到自己有权访问的其他工作区。

在已经初始化的 Harness Web profile 中安装插件。安装命令需要 `pnpm`。

```sh
npm pack ./integrations/deepseek-harness
dsh plugin --profile web add "$(pwd)/dsh-octoally-workspace-1.0.0.tgz"
```

在该 profile 的 `cordis.patch.yml` 添加 OctoAlly 的浏览器来源。使用完整来源，包含协议与端口且无尾斜杠。重启对应的 Harness 实例让配置生效。

```yaml
- id: octoally-workspace
  config:
    parentOrigins:
      - https://octoally.example.com
```

将 OctoAlly 与 Harness 放在同站点的独立来源，例如 `https://octoally.example.com` 和 `https://harness.example.com`。独立主机名使浏览器的 Host-only Cookie 各自归属对应应用。反代需允许嵌入，转发 WebSocket 与 Harness 登录 Cookie。先在浏览器顶层用 Harness 提供的登录入口建立会话，再回到 OctoAlly。在 **Agent 配置 → 新增 Provider → DeepSeek Harness** 输入不带登录参数的 Harness 根地址。进入项目后，用「＋」选择 **DeepSeek Harness**。

Harness 插件仅对已登录的所有者网页启用，并检查父窗口与配置的精确来源。OctoAlly 仅向已确认的 iframe 发送当前项目的路径。Harness 在服务端校验目录并保存会话。平台设置中的网址字段仅保存无凭据的根地址。

## 配置 xindu 模型

在 Harness 的 **设置 → 模型 → 添加模型提供方 → 自定义模型 API** 中创建 `xindu`。API 协议选 **OpenAI Responses**，从现有 OctoAlly `xindu` 配置取 API 基础地址，并使用其已授权的密钥来源。Harness 会将保存的密钥留在自身的凭据存储中。在模型选择器选择 **deepseek-v4-flash** 后作为新会话默认模型，模型列表还可包含 **deepseek-v4-pro**。

可用 Harness 的 `llm-pi-ai` profile 配置引用环境变量中的密钥，避免在 YAML 里存放明文。更多字段见 [Harness 模型配置](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)。

## 验证

`e2e/deepseek-harness.spec.ts` 的常规测试使用隔离网页验证设置保存、两个项目分别定位、项目切换、标签重命名及排序、刷新与关闭。用受控的 loopback Harness 实例启动 OctoAlly 插件并授权测试页面来源后，可通过 `E2E_DEEPSEEK_HARNESS_LOG` 指定该临时实例自己的启动日志，运行真实 Web 校验。日志含一次实例启动凭据，测试结束后随隔离实例一并清理。常规测试无需购买模型额度或访问线上服务。

可同时设置 `E2E_DEEPSEEK_HARNESS_MODEL`，验证已经配置的模型发送对话、显示答复和刷新恢复。使用线上模型时，此步骤会产生真实模型请求。
