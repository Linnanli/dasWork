# Agent Rules

## 协作偏好

- 使用简洁、易懂的中文，避免不必要的术语。
- 目标或范围存在会影响结果的歧义时先询问；目标明确后，普通实现细节自行判断并继续。

## 项目定位与职责

本仓库是以 Codex app server 为执行基座的 Electron 协作应用。Main 通过项目自有、AI-free 的 `@dascowork/codex-app-server-client` 持有 app-server 连接；不内置 AI SDK provider 兼容包。

- `desktop-app/src/renderer/`：界面；只调用 preload 暴露的业务 API。
- `desktop-app/src/preload/`、`shared/`：白名单桥接、共享类型、schema 和 IPC 合约。
- `desktop-app/src/main/`：app-server 生命周期、业务编排、本机能力和安全边界。`appTools/` 管理宿主工具；`primaryRuntime/` 管理受控工具依赖；`bundledPlugins/` 管理内置插件。
- `desktop-app/vendors/codex-app-server-client/`：transport、共享连接、协议、事件标准化和动态工具分发。
- Codex app server 负责模型推理、thread/turn、sandbox、审批与工具协议。Primary Runtime 提供宿主工具依赖和 bundled plugins，不负责模型请求。

**禁止修改 `codex/codex-rs/app-server/` 的代码。**

## 架构边界

- 禁止在桌面聊天推理路径中绕过 Codex app server 直接调用 OpenAI-compatible API、Responses API、第三方 SDK、`fetch` 模型接口或新建独立 LLM client。
- Renderer 仅通过受控表单接收并提交用户输入的凭据；已保存凭据的解密和模型请求配置由 Main 管理，不向 Renderer 回传已保存的 API Key、敏感 provider headers 或完整运行配置。
- 原生运行时的协议状态、共享连接、`initialize`、version probe 与 server request routing 由 Main 和 AI-free client 共同拥有；不得重新引入桌面侧 provider compatibility layer。
- Renderer 不能直接使用 Node/Electron、原始 app-server RPC、Native Pipe path、Primary Runtime root/下载源或宿主工具 schema。MCP 配置通过 preload 白名单管理：Main 校验提交内容并返回脱敏信息；Renderer 不直接执行 MCP 命令、访问原始配置文件或读取已保存凭据。新增桌面能力必须经过 preload 白名单、shared schema 和 Main handler。
- app-server 生成协议的唯一所有者是 `desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/`；Main 不维护第二份手写协议模型。
- 原生 `dynamicTools` 与 MCP/Native Pipe 的 `tools/list`、`tools/call`、`tools/cancel` 必须来自同一个 `DynamicAppToolRegistry`；Native Pipe/MCP 兼容链失败时应关闭该能力并保留原生聊天/工具链，不能隐式切换成另一套实现。
- 当前 TypeScript Native Pipe/MCP bridge 只算工程兼容实现；在 OS 级 peer identity、generation/ancestry 校验和 bundle provenance 独立审查完成前，它仍受 `AT-PIPE-*`、`AT-BUNDLE-01` 公开发布门禁约束。不得把路径权限或随机端点名当成完整认证。
- Primary Runtime 只提供宿主工具依赖与 bundled plugins，不能被当作 Codex app-server、模型 provider 或 renderer 通用文件系统入口。
- 涉及 `thread/start`、`thread/resume`、`turn/start`、approval、sandbox、cwd、MCP、dynamic tools、elicitation 或 recovery 的改动，优先确认应落在 AI-free client、Main runtime、Main appTools/primaryRuntime 还是 Renderer；由于本仓库禁止修改 app-server，若协议不支持所需能力，应先暴露并讨论边界，而不是在桌面端伪造语义。
- 工具或 Runtime 降级不得拖垮普通聊天。`codex-chat:attach` 只重连现有 run 并重放 journal，不创建新 turn。
- 原生 `dynamicTools` 在创建 thread 时按工具快照发布，恢复时不重新发布；已发布工具的实际可用性和 Runtime 依赖仍在调用时检查。MCP/Pipe 列表由同一注册表按查询上下文生成。`item/tool/call` 属于宿主工具调用，不进入审批分支。

## 按需查阅

只阅读当前任务相关的章节，无需在每次修改前通读文档。

| 任务 | 参考 |
| --- | --- |
| 分层定位、聊天/模型/工具排障、验证命令 | [开发链路与验证参考](docs/agent-development-guide.md) |
| app-server 协议、thread/turn、恢复 | [官方接口说明](docs/codex-app-server-official-notes.md)、[原生运行时 ADR](docs/adr/2026-09-03-codex-native-app-server-runtime.md) |
| App Tools、Primary Runtime、内置插件 | [Runtime ADR](docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md) |
| 本地 IPC、MCP/Native Pipe、安全或发布 | [IPC 安全 ADR](docs/adr/2026-09-07-app-tools-authenticated-local-ipc.md)、[Bridge 协议](docs/specs/codex-app-tools-bridge-protocol.md) |

assistant-ui 组件接口不明确时，可使用可用的 assistant-ui MCP 获取文档和示例。

## 验证与完成

- 先运行覆盖改动行为的检查，再按影响范围补充类型检查、lint 或集成验证。必要检查通过后，仅在新改动、失败或未解决疑点出现时扩大或重复验证。
- Desktop 代码基线：`npm --prefix desktop-app run lint`、`npm --prefix desktop-app run typecheck`、`npm --prefix desktop-app test`。AI-free client 改动运行 `npm --prefix desktop-app/vendors/codex-app-server-client run qa`。
- 协议、聊天或宿主工具链路改动，按[验证参考](docs/agent-development-guide.md#排障与验证)补充对应合约与端到端检查；发布仍需满足相关门禁。
- 纯文档改动检查内容、链接和差异，无需运行应用测试。完成时说明改动、验证结果及未验证项。

## 参考项目分析

涉及 `reference-projects/` 下的 Electron 解包项目时，先读取并遵循 [reference-electron-analysis 技能](.codex/skills/reference-electron-analysis/SKILL.md)。索引校验、有界查询、原文件证据和新版本解包流程统一由该技能维护，不直接读取大 bundle。人工说明见[参考项目分析文档](docs/reference-electron-analysis.md)。
