# Agent Rules

## 沟通规则

1. **不要假设用户清楚自己想要什么。** 当动机或目标不清晰时，停下来讨论，而不是猜测着往前冲。做错了再改的成本远高于多问一句。
2. **目标清晰但路径不是最短的，直接说并建议更好的办法。** 用户可能因为惯性选择了次优方案，AI 有责任指出更短的路径——但最终决定权在用户。
3. 使用非程序员黑话回答

## 项目全局架构

本仓库是以 Codex app server 为执行基座的 Electron 协作应用。生产聊天链路由 Electron Main 直接持有 app-server 连接，通过项目自有、AI-free 的 `@dascowork/codex-app-server-client` 通信。仓库不再内置 AI SDK provider 兼容包。

定位问题时先区分三类运行时：

- Codex app server：负责模型推理、thread/turn、sandbox、审批、MCP 和工具协议。
- Electron Main：负责 app-server 生命周期、桌面业务编排、本机能力和所有安全边界。
- Primary Runtime：向桌面宿主工具提供受控的 Node、Python、工具库、二进制和 bundled plugins；它不是 app-server，也不直接发起模型请求。

当前以 Codex app server 作为基础开发，禁止修改 `codex/codex-rs/app-server/` 的代码。

### 相关接口文档

- [Codex App Server 官方说明整理](docs/codex-app-server-official-notes.md)
- [原生 App Server Runtime ADR](docs/adr/2026-09-03-codex-native-app-server-runtime.md)
- [App Tools 与 Primary Runtime ADR](docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md)
- [App Tools 本地 IPC 安全 ADR](docs/adr/2026-09-07-app-tools-authenticated-local-ipc.md)
- [App Tools Bridge 协议](docs/specs/codex-app-tools-bridge-protocol.md)

### 分层职责

- `desktop-app/src/renderer/`：React、assistant-ui、AI SDK UI runtime；负责聊天、模型与模式选择、审批、项目/会话列表和右侧工作区。Renderer 只能调用 preload 提供的业务 API。
- `desktop-app/src/preload/`：`contextBridge` 安全桥；统一暴露 `window.desktopApp`，其下按 `codex`、`chat`、`projects`、`conversations`、`followUps`、`composerContext`、`plugins`、`git`、`workspace` 等命名空间提供白名单 API。普通请求使用 `ipcRenderer.invoke`，聊天启动/重连使用 `ipcRenderer.postMessage` 与 `MessagePort`。
- `desktop-app/src/shared/`：Renderer、Preload、Main 共用的业务类型、Zod schema 与 IPC channel contract；不承载任意 app-server JSON-RPC 透传。
- `desktop-app/src/main/`：Electron Main；负责窗口和 IPC 校验、共享 app-server 连接、唯一 `initialize`/版本探测、thread/turn 与恢复、流式 journal/重连、模型目录与敏感 provider 配置、审批、项目/会话、follow-up、插件、本地 Git 和右侧工作区能力。
- `desktop-app/src/main/appTools/`：Main-owned 的宿主工具能力层。`DynamicAppToolRegistry` 是唯一工具真相源，分别投影为新 thread 的原生 `dynamicTools` 和 `codex_app` MCP/Native Pipe 兼容入口；两条入口必须复用同一 handler。
- `desktop-app/src/main/primaryRuntime/`：Primary Runtime 的发现、诊断、可信安装、更新/修复、原子激活和依赖路径输出。只有健康的本地 Runtime 才发布 `load_workspace_dependencies`。
- `desktop-app/src/main/bundledPlugins/` 与 `desktop-app/resources/bundled-plugins/`：读取、校验并协调应用自带及 Primary Runtime 自带的 plugin marketplace；通过 app-server 的插件目录能力安装/升级/启用内部插件。
- `desktop-app/vendors/codex-app-server-client/`：项目自有、AI-free 的 app-server transport、共享连接、协议类型、各业务 client、中性事件 normalizer 和 dynamic tool dispatcher；生成的 app-server TypeScript 协议只在这里维护。它不是 Codex CLI 附带的 JavaScript 库。
- `codex/codex-rs/app-server/`：Codex 执行基座；负责 thread/turn 生命周期、cwd、sandbox、审批、MCP、工具调用、elicitation、模型 provider 配置和最终 LLM 请求。
- admin backend：可选的模型目录与 provider 配置来源，通过 `/api/client-models` 返回模型、base URL 和凭据。Main 将敏感配置写入 app-server 的 thread config；admin backend 不是桌面聊天推理链路的执行基座。

### 核心数据流

- 应用启动：Main 创建 `PrimaryRuntimeService` 与 `DesktopHostCapabilityRuntime`，启动 App Tools bridge、协调 bundled plugins，再创建共享 `CodexAppServerConnection`/`HostCodexConnection`、history/context clients 和 `CodexChatRuntimeService`。工具或 Runtime 降级不得拖垮普通聊天。
- 模型列表：Renderer 调 `window.desktopApp.codex.listModels()` -> Preload `codex:list-models` -> Main `CodexChatRuntimeService.listModels()`。配置了 admin backend 时只走 `ModelCatalogService` 与其缓存；未配置时才走 `NativeCodexRunDriver.listModels()` -> `HostCodexConnection` -> app-server `model/list`。不能把“已配置 admin 但请求失败”误写成自动回退 app-server catalog。
- 聊天流：assistant-ui -> `ElectronIpcChatTransport` -> `window.desktopApp.chat.startChatStream()` -> Preload `codex-chat:start` + `MessagePort` -> Main Zod 校验 -> `CodexChatRuntimeService` -> 本次 `DesktopCapabilitySnapshot` -> `CodexRunDriver`/`NativeCodexRunDriver` -> `HostCodexConnection` -> AI-free client -> stdio JSON-RPC -> `codex app-server` -> 内建或 admin 配置的 custom model provider。app-server 中性事件经 `CodexRunEventNormalizer` 和 `CodexUiMessageAdapter` 转为 `UIMessageChunk`，由 Main journal 经 MessagePort 回到 Renderer；`codex-chat:attach` 只重连现有 run 和重放 journal，不创建新 turn。
- 审批流：app-server 发出 command、file change、tool user input、permission 或 MCP elicitation server request -> `NativeCodexRunDriver` 穷举路由 -> `CodexChatRuntimeService`/`CodexApprovalBroker`（内部用 `ApprovalCoordinator` 保留上下文）-> Main 推送 `codex:approval-request` -> Renderer 审批面板 -> `codex:respond-approval` -> broker resolve -> app-server。`item/tool/call` 属于宿主动态工具调用，不得混进审批分支。
- 宿主工具流：Main 在新 thread 创建前取得不可变 capability snapshot -> `thread/start.dynamicTools` -> app-server `item/tool/call` -> `DynamicAppToolRegistry` -> 具体桌面 handler -> app-server。恢复已有 thread 不重新发布 `dynamicTools`；Runtime、plugin 或工具目录变化只影响新 thread。`codex_app` MCP/Native Pipe 是同一注册表的兼容投影，不是原生工具主链的依赖或第二个工具真相源。
- app-server 启动：默认从应用进程的 `PATH` 执行 `codex app-server --listen stdio://`；`CODEX_APP_SERVER_BIN` 只用于测试替身。

### 架构边界

- 禁止在桌面聊天推理路径中绕过 Codex app server 直接调用 OpenAI-compatible API、Responses API、第三方 SDK、`fetch` 模型接口或新建独立 LLM client。
- 禁止把 admin backend 返回的 API key、provider headers 或完整模型配置暴露给 renderer；敏感信息只能在 main process 和 app-server 子进程边界内流动。
- 原生运行时的协议状态、共享连接、`initialize`、version probe 与 server request routing 由 Main 和 AI-free client 共同拥有；不得重新引入桌面侧 provider compatibility layer。
- Renderer 不能直接使用 Node/Electron、原始 app-server RPC、MCP command/env、Native Pipe path、Primary Runtime root/下载源或宿主工具 schema。新增桌面能力必须经过 preload 白名单、shared schema 和 Main handler。
- app-server 生成协议的唯一所有者是 `desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/`；Main 不维护第二份手写协议模型。
- 原生 `dynamicTools` 与 MCP/Native Pipe 的 `tools/list`、`tools/call`、`tools/cancel` 必须来自同一个 `DynamicAppToolRegistry`；Native Pipe/MCP 兼容链失败时应关闭该能力并保留原生聊天/工具链，不能隐式切换成另一套实现。
- 当前 TypeScript Native Pipe/MCP bridge 只算工程兼容实现；在 OS 级 peer identity、generation/ancestry 校验和 bundle provenance 独立审查完成前，它仍受 `AT-PIPE-*`、`AT-BUNDLE-01` 公开发布门禁约束。不得把路径权限或随机端点名当成完整认证。
- Primary Runtime 只提供宿主工具依赖与 bundled plugins，不能被当作 Codex app-server、模型 provider 或 renderer 通用文件系统入口。
- 涉及 `thread/start`、`thread/resume`、`turn/start`、approval、sandbox、cwd、MCP、dynamic tools、elicitation 或 recovery 的改动，优先确认应落在 AI-free client、Main runtime、Main appTools/primaryRuntime 还是 Renderer；由于本仓库禁止修改 app-server，若协议不支持所需能力，应先暴露并讨论边界，而不是在桌面端伪造语义。

### 排障与验证

遇到“发送无回复”“模型不可用”“custom provider 不生效”时按链路排查：Renderer 是否发出 `codex-chat:start`/`codex-chat:attach` -> Main 是否通过 shared schema 并进入 runtime -> `HostCodexConnection` 是否完成版本探测和每个 connection generation 唯一一次 `initialize`/`initialized` -> 当前模型目录分支是 admin backend 还是 app-server `model/list` -> native driver 是否发送正确的 `thread/start`/`thread/resume`/`turn/start` -> app-server thread config 是否包含期望的 `model_provider`/`model_providers` -> app-server 是否请求目标 provider -> 中性事件是否经过 normalizer、`CodexUiMessageAdapter` 与 runtime journal，最终经 MessagePort 回到 Renderer。

遇到“桌面工具不可用”“Primary Runtime 未生效”“bundled plugin 缺失”时按能力链排查：Primary Runtime diagnose/active pointer -> bundled plugin descriptor 与 reconcile -> `DesktopHostCapabilityRuntime.snapshot()` -> 新 thread 的 `dynamicTools` 与 desktop thread config -> app-server `item/tool/call` -> `DynamicAppToolRegistry.dispatch()`。不要在恢复旧 thread 时期待工具目录热更新，也不要用 MCP/Pipe 兼容链代替原生 dynamic tools 证据。

推荐验证：

- AI-free client：`npm --prefix desktop-app/vendors/codex-app-server-client run qa`。
- Desktop 基线：`npm --prefix desktop-app run lint`、`npm --prefix desktop-app run typecheck`、`npm --prefix desktop-app test`。
- 原生运行时与协议边界：`npm --prefix desktop-app run verify:codex-native-runtime-boundaries`、`npm --prefix desktop-app run verify:codex-app-server-protocol-contract`、`npm --prefix desktop-app run verify:real-codex-app-server-contract`。
- App Tools / Primary Runtime / bundled plugins：`npm --prefix desktop-app run verify:bundled-plugins`、`npm --prefix desktop-app run verify:app-tools-release-gates`、`npm --prefix desktop-app run test:primary-runtime-real`、`npm --prefix desktop-app run test:primary-runtime:stress`、`npm --prefix desktop-app run smoke:packaged-app-tools`；涉及 Presentations 时再加 `npm --prefix desktop-app run smoke:presentations-runtime`。
- 聊天、模型供应商或宿主工具全链路：`npm --prefix desktop-app run test:e2e -- --reporter=line`，并确保断言覆盖真实 Renderer -> IPC -> Main -> AI-free client -> Codex app server -> custom provider，以及需要时的 `item/tool/call` -> Main registry 路径。

## 工具说明

assistant-ui组件可以使用assistant-ui mcp获取文档和示例信息

## 参考项目分析规则

- 只要任务涉及 `reference-projects/` 下的 Electron 解包项目，必须先加载项目技能 `.codex/skills/reference-electron-analysis/SKILL.md`，按其中的低 token 索引流程执行。
- 人工使用说明见 `docs/reference-electron-analysis.md`。
- 默认先运行完整的 `reference:chatgpt:validate`，再用 `reference:chatgpt:query` 返回不超过 8 个候选；禁止把大 bundle 或无上限的图概览直接塞进模型上下文。
- 跨文件关系才生成最多 30 个文件的语义切片，并只在切片上使用 LSP 或 code-review-graph。
- 图、索引、LSP 和反编译结果都只是定位工具。最终行为结论必须回查原参考文件并给出精确行号；新解包版本还要给出 `_analysis/raw/` 中排版前原包的行、列和 SHA256。
- 新版本统一通过 `npm --prefix desktop-app run reference:chatgpt -- --force` 解包；该命令会自动保留原包文本镜像并生成索引。
