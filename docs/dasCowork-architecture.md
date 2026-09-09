# dasCowork 当前架构

本文描述桌面应用当前的生产架构。架构约束以仓库根目录的 `AGENTS.md` 为准；本文用于说明组件关系、数据流和修改入口。

## 1. 总览

`dasCowork` 是以 Codex app server 为执行基座的 Electron 协作应用。桌面生产聊天不经过 AI SDK Provider：Electron Main 直接持有 app-server 连接，并通过项目自有、AI-free 的 `@dascowork/codex-app-server-client` 使用 app-server 协议。

三类运行时必须分开理解：

- **Codex app server**：负责模型推理、thread/turn、sandbox、审批、MCP 和工具协议。
- **Electron Main**：负责 app-server 生命周期、桌面业务编排、本机能力和安全边界。
- **Primary Runtime**：为桌面宿主工具提供受控的 Node、Python、工具库、二进制和 bundled plugins；它不是 app-server，也不直接发起模型请求。

本仓库不再内置 `desktop-app/vendors/ai-sdk-provider-codex-asp/`。桌面端也不得重新引入兼容 Provider 或绕过 app-server 直接请求模型 API。

## 2. 目录与职责

| 目录 | 职责 |
| --- | --- |
| `desktop-app/src/renderer/` | React、assistant-ui 和 AI SDK UI runtime；负责界面与 `UIMessageChunk` 消费，不持有模型连接。 |
| `desktop-app/src/preload/` | `contextBridge` 白名单桥；统一暴露 `window.desktopApp`。普通请求使用 `ipcRenderer.invoke`，聊天流使用 `postMessage` 与 `MessagePort`。 |
| `desktop-app/src/shared/` | Renderer、Preload、Main 共用的业务类型、Zod schema 和 IPC channel contract。 |
| `desktop-app/src/main/` | Electron Main；负责窗口、IPC 校验、app-server 共享连接、聊天、恢复、模型目录、审批、项目、会话、插件、Git 和工作区能力。 |
| `desktop-app/src/main/appTools/` | Main-owned 宿主工具层；`DynamicAppToolRegistry` 是唯一工具真相源。 |
| `desktop-app/src/main/primaryRuntime/` | Primary Runtime 的发现、诊断、可信安装、更新、原子激活和依赖路径输出。 |
| `desktop-app/src/main/bundledPlugins/` | 校验并协调应用和 Primary Runtime 自带的 plugin marketplace。 |
| `desktop-app/vendors/codex-app-server-client/` | AI-free app-server transport、连接管理、协议类型、业务 client、事件 normalizer 和 dynamic tool dispatcher。 |
| `codex/codex-rs/app-server/` | Codex 执行基座；本仓库当前禁止修改。 |

生成的 app-server TypeScript 协议只在 `desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/` 维护，Main 不保留第二份手写协议模型。

## 3. 逻辑架构

```mermaid
flowchart LR
  UI[Renderer\nReact / assistant-ui] -->|window.desktopApp| PRE[Preload\n白名单 API]
  PRE -->|IPC + MessagePort| MAIN[Electron Main]
  MAIN --> CHAT[CodexChatRuntimeService]
  CHAT --> DRIVER[NativeCodexRunDriver]
  DRIVER --> HOST[HostCodexConnection]
  HOST --> CLIENT[@dascowork/codex-app-server-client]
  CLIENT -->|stdio JSON-RPC| SERVER[codex app-server]
  SERVER --> MODEL[模型 provider]
  SERVER --> CORE[thread / turn / sandbox / MCP]

  MAIN --> CAPS[DesktopHostCapabilityRuntime]
  CAPS --> REG[DynamicAppToolRegistry]
  MAIN --> PRIMARY[PrimaryRuntimeService]
  PRIMARY --> CAPS
  REG -->|thread/start.dynamicTools| SERVER
  SERVER -->|item/tool/call| REG

  SERVER -->|审批 server request| DRIVER
  DRIVER --> BROKER[CodexApprovalBroker]
  BROKER -->|安全 DTO| UI
```

Renderer 中仍使用 AI SDK/assistant-ui 的 UI runtime，但只把它作为消息与渲染抽象。模型请求、app-server 协议状态和连接池全部位于 Main 与 AI-free client。

## 4. 应用启动

Main 启动时按以下顺序建立桌面能力：

1. 创建 `PrimaryRuntimeService`，诊断当前 Runtime。
2. 创建 `DesktopHostCapabilityRuntime` 和 `DynamicAppToolRegistry`。
3. 启动 App Tools bridge，并协调 bundled plugins。
4. 创建共享 `CodexAppServerConnection` / `HostCodexConnection`。
5. 创建 history/context clients 与 `CodexChatRuntimeService`。

工具、Primary Runtime 或兼容 bridge 降级不能拖垮普通聊天。

app-server 默认通过应用进程的 `PATH` 启动：

```text
codex app-server --listen stdio://
```

`CODEX_APP_SERVER_BIN` 只供测试替身使用。共享连接负责版本探测，并保证每个 connection generation 只完成一次 `initialize` / `initialized`。

## 5. 模型列表

```text
Renderer
  -> window.desktopApp.codex.listModels()
  -> Preload: codex:list-models
  -> CodexChatRuntimeService.listModels()
```

后续分为两个互斥来源：

- 配置 admin backend 时，只走 `ModelCatalogService` 及其缓存。
- 未配置 admin backend 时，走 `NativeCodexRunDriver.listModels()` → `HostCodexConnection` → app-server `model/list`。

“已配置 admin backend 但请求失败”不会自动回退到 app-server catalog。API key、provider headers 和完整模型配置只允许在 Main 与 app-server 子进程边界内流动。

## 6. 聊天与恢复

```text
assistant-ui
  -> ElectronIpcChatTransport
  -> window.desktopApp.chat.startChatStream()
  -> codex-chat:start + MessagePort
  -> Main Zod 校验
  -> CodexChatRuntimeService
  -> NativeCodexRunDriver
  -> HostCodexConnection
  -> @dascowork/codex-app-server-client
  -> codex app-server
```

新任务使用 `thread/start`，已有任务使用 `thread/resume`，随后由 `turn/start` 启动本轮。app-server 的中性事件依次经过 `CodexRunEventNormalizer`、`CodexUiMessageAdapter` 和 Main-owned journal，最终以 `UIMessageChunk` 经 MessagePort 返回 Renderer。

`codex-chat:attach` 只附加现有 run 并重放 journal，不会创建新 turn。Renderer 断开只影响传输；Main 继续持有权威 run 状态、序号和终态。

## 7. 审批

app-server 可能发出命令、文件变更、工具输入、权限或 MCP elicitation server request。`NativeCodexRunDriver` 穷举协议分支并交给 `CodexChatRuntimeService` / `CodexApprovalBroker`：

```text
app-server server request
  -> NativeCodexRunDriver
  -> CodexApprovalBroker
  -> codex:approval-request
  -> Renderer 审批面板
  -> codex:respond-approval
  -> broker resolve
  -> app-server response
```

Main 保留原始协议上下文，只把白名单 DTO 发送给 Renderer。`item/tool/call` 是宿主动态工具调用，不属于审批分支。

## 8. 宿主工具、Primary Runtime 与插件

Main 在创建新 thread 前生成不可变 `DesktopCapabilitySnapshot`，并通过 `thread/start.dynamicTools` 发布工具定义。app-server 发出 `item/tool/call` 后，由 `DynamicAppToolRegistry` 调用对应桌面 handler。

规则如下：

- 恢复已有 thread 时不重新发布 `dynamicTools`。
- Runtime、plugin 或工具目录变化只影响新 thread。
- `codex_app` MCP/Native Pipe 是同一注册表的兼容投影，不是第二套工具实现。
- Native Pipe/MCP 失败时关闭该兼容能力，保留原生聊天和 dynamic tools。
- 只有健康的本地 Primary Runtime 才发布 `load_workspace_dependencies`。

TypeScript Native Pipe/MCP bridge 仍受公开发布门禁约束，路径权限或随机端点名不能替代 OS 级身份校验。

## 9. 安全边界

- Renderer 不能直接使用 Node/Electron、原始 app-server RPC 或任意文件系统入口。
- 新桌面能力必须经过 preload 白名单、shared schema 和 Main handler。
- Main 不能把 admin backend 的凭据或完整 provider 配置发给 Renderer。
- 桌面聊天不能直接调用 OpenAI-compatible API、Responses API、第三方模型 SDK 或 `fetch` 模型接口。
- app-server 协议状态、共享连接、初始化、版本探测和 server request routing 由 Main 与 AI-free client 持有。
- `thread/start`、`thread/resume`、`turn/start`、approval、sandbox、cwd、MCP、dynamic tools、elicitation 和 recovery 的语义不能在桌面端伪造。
- Primary Runtime 只提供宿主工具依赖与 bundled plugins，不是模型运行时或 Renderer 通用文件系统入口。

## 10. 定位入口

| 能力 | 主要文件 |
| --- | --- |
| 聊天编排与 journal | `desktop-app/src/main/codexChatRuntimeService.ts` |
| 原生 thread/turn 与事件路由 | `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts` |
| app-server 共享连接 | `desktop-app/src/main/codexRun/HostCodexConnection.ts`、`desktop-app/vendors/codex-app-server-client/src/client/` |
| app-server 启动 | `desktop-app/src/main/codexAppServerLaunch.ts` |
| UI 流式传输 | `desktop-app/src/renderer/src/lib/ElectronIpcChatTransport.ts`、`desktop-app/src/preload/chatStreamBridge.ts` |
| IPC 契约 | `desktop-app/src/shared/codexIpcApi.ts` |
| 审批 | `desktop-app/src/main/codexApprovalBroker.ts`、`desktop-app/src/main/approvals/` |
| 宿主工具 | `desktop-app/src/main/appTools/` |
| Primary Runtime | `desktop-app/src/main/primaryRuntime/` |
| bundled plugins | `desktop-app/src/main/bundledPlugins/`、`desktop-app/resources/bundled-plugins/` |
| 模型目录 | `desktop-app/src/main/modelCatalogService.ts` |

## 11. 验证

最小验证组合：

```bash
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app test
npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:real-codex-app-server-contract
```

App Tools、Primary Runtime 或 bundled plugins 改动还需运行对应 release gate、真实 Runtime smoke 和 packaged smoke。涉及真实聊天链路时，端到端证据必须覆盖 Renderer → IPC → Main → AI-free client → Codex app server，必要时再覆盖 `item/tool/call` → Main registry。
