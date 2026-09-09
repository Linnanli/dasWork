# Codex App Tools 与 Primary Runtime 的主进程边界

日期：2026-09-06

## 决定

桌面端将宿主工具建模为由 Electron main 唯一持有的 `DynamicAppToolRegistry`。同一份工具定义分别投影到：

- 新任务的 `thread/start.dynamicTools`；
- `codex_app` Native Pipe/MCP 兼容入口。

原生 dynamic tools 是生产聊天的主路径：Renderer 只经既有 IPC 与消息端口发起聊天，`CodexRunDriver` 和 `NativeCodexRunDriver` 在新任务时接收不可变工具快照，app-server 的 `item/tool/call` 只回到 main。恢复已有任务不会伪造 `dynamicTools`，临时任务默认不发布工具。

`DynamicToolsDispatcher` 继续属于 AI-free app-server client，负责协议调用的执行、超时、取消与结果归一化；main 的 registry 只定义业务工具、可用性与两种协议投影。因此不存在 renderer 输入的工具 schema、MCP command/env、Pipe path 或 Runtime 根目录。

Primary Runtime 也由 main 诊断并提供；`load_workspace_dependencies` 是 local-only、无参数、只读工具。它只在可执行的受控 Runtime 存在时发布，提示词与该次动态工具快照来自同一 capability revision。

打包的 `codex-app-tools` 资源由 hash 锁定、在启动时以 main-owned MCP 配置连接私有 Pipe；插件注册仅负责发现和管理，不是第二个激活来源。Unix socket 目录和 socket 分别限制为 `0700` 和 `0600`。Windows 在具备命名管道 ACL 实现前明确禁用该兼容入口，避免把未授权 IPC 当作可接受的降级。

## 不采用的方案

- 不在生产聊天路径引入 AI SDK Provider 兼容层或直接调用模型 API。
- 不修改 `codex/codex-rs/app-server` 或 `codex/codex-rs/core`。
- 不让 Native Pipe 成为原生工具的依赖；二者是同一注册表的独立投影。
- 不把 Runtime 路径或下载/安装控制权暴露给 renderer。

## 后果

工具、提示词和实际 handler 必须通过相同 capability snapshot 发布。Runtime、插件或 Pipe 发生变化后，只影响新任务；已有任务维持创建时的目录，而 handler 每次调用仍会重新检查 Runtime 健康状态并安全失败。
