# 开发链路与验证参考

本文保存从根 AGENTS.md 移出的分层职责、数据流、排障与验证说明。修改相关链路或排障时查阅对应章节；一般任务无需通读。项目约束以 [AGENTS.md](../AGENTS.md) 为入口。

## 分层职责

- `desktop-app/src/renderer/`：React、assistant-ui、AI SDK UI runtime；负责聊天、模型与模式选择、审批、项目/会话列表和右侧工作区。Renderer 只能调用 preload 提供的业务 API。
- `desktop-app/src/preload/`：`contextBridge` 安全桥；统一暴露 `window.desktopApp`，其下按 `codex`、`chat`、`projects`、`conversations`、`followUps`、`composerContext`、`plugins`、`git`、`workspace` 等命名空间提供白名单 API。普通请求使用 `ipcRenderer.invoke`，聊天启动/重连使用 `ipcRenderer.postMessage` 与 `MessagePort`。
- `desktop-app/src/shared/`：Renderer、Preload、Main 共用的业务类型、Zod schema 与 IPC channel contract；不承载任意 app-server JSON-RPC 透传。
- `desktop-app/src/main/`：Electron Main；负责窗口和 IPC 校验、共享 app-server 连接、唯一 `initialize`/版本探测、thread/turn 与恢复、流式 journal/重连、模型目录与敏感 provider 配置、审批、项目/会话、follow-up、插件、本地 Git 和右侧工作区能力。
- `desktop-app/src/main/appTools/`：Main-owned 的宿主工具能力层。`DynamicAppToolRegistry` 是唯一工具真相源，分别投影为新 thread 的原生 `dynamicTools` 和 `codex_app` MCP/Native Pipe 兼容入口；两条入口必须复用同一 handler。
- `desktop-app/src/main/primaryRuntime/`：Primary Runtime 的发现、诊断、可信安装、更新/修复、原子激活和依赖路径输出。只有健康的本地 Runtime 才发布 `load_workspace_dependencies`。
- `desktop-app/src/main/bundledPlugins/` 与 `desktop-app/resources/bundled-plugins/`：读取、校验并协调应用自带及 Primary Runtime 自带的 plugin marketplace；通过 app-server 的插件目录能力安装/升级/启用内部插件。
- `desktop-app/vendors/codex-app-server-client/`：项目自有、AI-free 的 app-server transport、共享连接、协议类型、各业务 client、中性事件 normalizer 和 dynamic tool dispatcher；生成的 app-server TypeScript 协议只在这里维护。它不是 Codex CLI 附带的 JavaScript 库。
- `codex/codex-rs/app-server/`：Codex 执行基座；负责 thread/turn 生命周期、cwd、sandbox、审批、MCP、工具调用、elicitation、模型 provider 配置和最终 LLM 请求。
- 本地模型配置：Main 将用户添加的模型、平台和加密后的 API Key，以及自动生成的 Codex 模型目录，保存在同一份 `local-models.json`；启动时以该文件作为 app-server 的 `model_catalog_json`。provider 的地址和解密后的凭据只通过 thread config 传给 app-server。

## 核心数据流

- 应用启动：Main 创建 `PrimaryRuntimeService` 与 `DesktopHostCapabilityRuntime`，启动 App Tools bridge、协调 bundled plugins，再创建共享 `CodexAppServerConnection`/`HostCodexConnection`、history/context clients 和 `CodexChatRuntimeService`。工具或 Runtime 降级不得拖垮普通聊天。
- 模型列表：Renderer 调 `window.desktopApp.codex.listModels()` -> Preload `codex:list-models` -> Main `CodexChatRuntimeService.listModels()` -> app-server `model/list`（由本地 `local-models.json` 的 Codex 目录部分提供），并合并 Main 中带平台信息的本地模型记录。添加模型通过 `codex:add-local-model` 原子更新同一文件；Codex 目录部分由应用自动重建。
- 聊天流：assistant-ui -> `ElectronIpcChatTransport` -> `window.desktopApp.chat.startChatStream()` -> Preload `codex-chat:start` + `MessagePort` -> Main Zod 校验 -> `CodexChatRuntimeService` -> 本次 `DesktopCapabilitySnapshot` -> `CodexRunDriver`/`NativeCodexRunDriver` -> `HostCodexConnection` -> AI-free client -> stdio JSON-RPC -> `codex app-server` -> 内建或本地配置的 custom model provider。app-server 中性事件经 `CodexRunEventNormalizer` 和 `CodexUiMessageAdapter` 转为 `UIMessageChunk`，由 Main journal 经 MessagePort 回到 Renderer；`codex-chat:attach` 只重连现有 run 和重放 journal，不创建新 turn。
- 审批流：app-server 发出 command、file change、tool user input、permission 或 MCP elicitation server request -> `NativeCodexRunDriver` 穷举路由 -> `CodexChatRuntimeService`/`CodexApprovalBroker`（内部用 `ApprovalCoordinator` 保留上下文）-> Main 推送 `codex:approval-request` -> Renderer 审批面板 -> `codex:respond-approval` -> broker resolve -> app-server。`item/tool/call` 属于宿主动态工具调用，不得混进审批分支。
- 宿主工具流：Main 在新 thread 创建前取得不可变 capability snapshot -> `thread/start.dynamicTools` -> app-server `item/tool/call` -> `DynamicAppToolRegistry` -> 具体桌面 handler -> app-server。恢复已有 thread 不重新发布 `dynamicTools`；原生工具声明的更新需创建新 thread，已发布工具的实际可用性和 Runtime 依赖仍在调用时检查。MCP/Pipe 的工具列表按查询上下文生成。`codex_app` MCP/Native Pipe 是同一注册表的兼容投影，不是原生工具主链的依赖或第二个工具真相源。
- app-server 启动：默认从应用进程的 `PATH` 执行 `codex app-server --listen stdio://`；`CODEX_APP_SERVER_BIN` 只用于测试替身。

## 排障与验证

遇到“发送无回复”“模型不可用”“custom provider 不生效”时按链路排查：Renderer 是否发出 `codex-chat:start`/`codex-chat:attach` -> Main 是否通过 shared schema 并进入 runtime -> `HostCodexConnection` 是否完成版本探测和每个 connection generation 唯一一次 `initialize`/`initialized` -> `local-models.json` 的 `model_catalog_json` 与 app-server `model/list` -> native driver 是否发送正确的 `thread/start`/`thread/resume`/`turn/start` -> app-server thread config 是否包含期望的 `model_provider`/`model_providers` -> app-server 是否请求目标 provider -> 中性事件是否经过 normalizer、`CodexUiMessageAdapter` 与 runtime journal，最终经 MessagePort 回到 Renderer。

遇到“桌面工具不可用”“Primary Runtime 未生效”“bundled plugin 缺失”时按能力链排查：Primary Runtime diagnose/active pointer -> bundled plugin descriptor 与 reconcile -> `DesktopHostCapabilityRuntime.snapshot()` -> 新 thread 的 `dynamicTools` 与 desktop thread config -> app-server `item/tool/call` -> `DynamicAppToolRegistry.dispatch()`。不要在恢复旧 thread 时期待工具目录热更新，也不要用 MCP/Pipe 兼容链代替原生 dynamic tools 证据。

按改动涉及的模块选择以下验证命令；无需每次全部运行。压力测试、真实服务和打包检查用于对应链路的变更或发布验证。运行前确认所需环境与外部访问条件，不将真实服务检查视为纯本地测试。

- AI-free client：`npm --prefix desktop-app/vendors/codex-app-server-client run qa`。
- Desktop 基线：`npm --prefix desktop-app run lint`、`npm --prefix desktop-app run typecheck`、`npm --prefix desktop-app test`。
- 原生运行时与协议边界：`npm --prefix desktop-app run verify:codex-native-runtime-boundaries`、`npm --prefix desktop-app run verify:codex-app-server-protocol-contract`、`npm --prefix desktop-app run verify:real-codex-app-server-contract`。
- App Tools / Primary Runtime / bundled plugins：`npm --prefix desktop-app run verify:bundled-plugins`、`npm --prefix desktop-app run verify:app-tools-release-gates`、`npm --prefix desktop-app run test:primary-runtime-real`、`npm --prefix desktop-app run test:primary-runtime:stress`、`npm --prefix desktop-app run smoke:packaged-app-tools`。
- 聊天、模型供应商或宿主工具全链路：`npm --prefix desktop-app run test:e2e -- --reporter=line`，并确保断言覆盖真实 Renderer -> IPC -> Main -> AI-free client -> Codex app server -> custom provider，以及需要时的 `item/tool/call` -> Main registry 路径。

