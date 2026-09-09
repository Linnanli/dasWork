# Codex App Tools、Primary Runtime 与 Presentations 完整复刻计划（重构后修订版）

日期：2026-09-06
模式：`$plan` direct
状态：实施中；截至 2026-09-07 尚未满足里程碑 D 和公开发布完成条件
替代版本：2026-09-03 初版

## 1. 目标和“完整复刻”的定义

本计划以参考项目 `codex-electron-26.818.21641` 的**可观察行为、生命周期和安全边界完整复刻**为目标，不要求复原缺失源码、内部类名或不可观察的私有实现。

完整复刻必须同时覆盖五条闭环：

1. **原生动态工具闭环**：Electron main 在新 thread 创建时把宿主工具通过 `thread/start.dynamicTools` 交给 app-server；app-server 用 `item/tool/call` 把调用交回 main；宿主返回协议结果。
2. **Codex App Tools 兼容闭环**：固定版本的 `codex-app-tools` 作为 `codex_app` stdio MCP server 启动，经 Native Pipe 调用同一套宿主工具注册表，并支持 list/call/cancel。
3. **Primary Runtime 闭环**：能发现、诊断、安装、校验、更新、修复、取消和回滚 Runtime；`load_workspace_dependencies` 只返回健康 Runtime 的路径。
4. **Bundled Plugin 闭环**：自动协调 `openai-bundled/codex-app-tools` 与 Runtime 中的 `openai-primary-runtime` marketplace，内部插件可安装、升级、恢复、隐藏和诊断。
5. **Presentations 产物闭环**：新 thread 能发现 Presentations skill，调用 `load_workspace_dependencies`，使用 Runtime 自带 Node 和 `@oai/artifact-tool` 生成、渲染并验证 `.pptx`。

“完整”不等于把所有能力强制串成一条链。参考项目存在两条工具入口；本项目必须都实现，但它们必须投影自同一个注册表、共享同一个 handler，不能互相依赖或产生两个同名工具实例。

### 1.1 里程碑

- **里程碑 A——原生工具主链**：`dynamicTools → item/tool/call → main registry → load_workspace_dependencies` 使用 fixture Runtime 通过。
- **里程碑 B——MCP/Pipe 兼容链**：真实 `server.mjs → Native Pipe → 同一 registry` 的 list/call/cancel 通过，结果与原生主链等价。
- **里程碑 C——通用平台**：Primary Runtime 和两个 marketplace 的生命周期、能力快照、降级及打包完成。
- **里程碑 D——完整复刻验收**：真实 Presentations skill 和 `@oai/artifact-tool` 生成有效 PPTX；开发、packaged、发布门禁全部有证据。

### 1.2 需求摘要

必须交付：

- 一个 main-owned、可扩展的宿主工具注册表，以及原生 dynamic tool 和 MCP/Native Pipe 两种投影。
- 一个只读、无参数、local-only 的 `load_workspace_dependencies`，返回经过校验的 Primary Runtime 路径。
- Primary Runtime 的完整生命周期、可信安装源、安全解压、原子更新和失败回滚。
- `openai-bundled` 与 `openai-primary-runtime` 两个 marketplace 的数据驱动协调。
- 能力快照、提示词、工具目录和实际 handler 的一致降级。
- 真实 Presentations skill 使用 Runtime 的 `@oai/artifact-tool` 生成并验证 PPTX。
- 开发、单元、集成、Electron E2E、packaged smoke 和发布安全门禁。

明确不包含：

- 不修改或 fork Codex app-server。
- 不恢复 provider 作为桌面生产运行时。
- 不复制参考项目整个 `external/`，也不把约 1.6GB Runtime 提交到 Git。
- 不向 renderer 暴露任意 Node、文件系统、app-server JSON-RPC、MCP 或 Runtime 管理权限。
- 不在本计划中重做 PPTX 预览 UI；仅在最终阶段接入现有 Artifact/PPTX 入口的 smoke。
- 不把反编译/重写 proprietary `server.mjs` 作为工程复刻前置；公开发布仍受授权或 clean-room 替代门禁约束。

## 2. 架构决定

### 2.1 必须遵守

- **不修改 Codex app-server**：禁止修改 `codex/codex-rs/app-server/**` 和 `codex/codex-rs/core/**`。
- **不把生产聊天接回 provider**：桌面生产链继续由 Electron main 持有 `HostCodexConnection`、`CodexRunDriver`、`NativeCodexRunDriver` 和 AI-free `@dascowork/codex-app-server-client`。`ai-sdk-provider-codex-asp` 只保留仓库外兼容测试。
- **一个 app-server 协议所有者**：app-server 生成协议只属于 `desktop-app/vendors/codex-app-server-client`；main 不维护第二份手写 app-server 模型。Native Pipe 是独立、窄范围的宿主协议，可在 `appTools/` 下定义 frame 和 Zod schema。
- **一个工具真相源**：原生 `dynamicTools` 与 Native Pipe 的 `tools/list/tools/call` 都从 `DynamicAppToolRegistry` 派生。
- **只在新 thread 发布目录**：当前协议只有 `ThreadStartParams` 支持 `dynamicTools`；Runtime 或插件变化默认提示“新任务生效”，不伪装成 resume/下一 turn 热更新。
- **main-only 信任边界**：renderer 不能指定 MCP command/env、Pipe path、Runtime 下载 URL、安装 root 或工具输入 schema。
- **失败关闭工具，不拖垮聊天**：工具、Pipe、MCP 或 Runtime 失败时普通聊天继续；提示词和工具目录必须同步降级。

### 2.2 完整复刻而不回退旧架构

初版通过 provider 的 `mcpServers` 接缝注入 `codex_app`，与当前已接受的原生运行时 ADR 冲突。修订版改为：

```text
Renderer / assistant-ui
  → Preload MessagePort
  → CodexChatRuntimeService
  → CodexRunDriver
  → NativeCodexRunDriver
  → AI-free app-server client
  → codex app-server
```

所有宿主能力从 main-owned `DesktopHostCapabilityRuntime` 注入这条链。禁止在 `desktop-app/src/main/**` 引入 `@janole/ai-sdk-provider-codex-asp`；现有边界验证器在 [verify-codex-native-runtime-boundaries.mjs](/Users/nallylin/Documents/code/dasCowork/desktop-app/scripts/verify-codex-native-runtime-boundaries.mjs:10) 已把它列为违规。

## 3. 参考项目证据和证据边界

### 3.1 索引状态

已执行完整校验：`7188/7188` 个文件通过，`sourceMode=beautified-fallback`。旧包没有 `_analysis/raw/` 排版前镜像，因此以下证据只引用当前可读文件的精确行号和 SHA256，不声称原包行列号。

### 3.2 原生动态工具链

以下连接证据证明 `load_workspace_dependencies` 是普通新会话的原生动态工具，而不是必须经过 MCP/Pipe 才能调用：

1. 新会话参数从宿主请求 `dynamicTools`：[app-initial-DOX-K1rC.js:134718](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:134718)。
2. 请求由 `dynamic-tools-for-thread-start-requested` 事件获取：[app-initial-DOX-K1rC.js:135323](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:135323)。
3. `load_workspace_dependencies` 被定义为只读、无参数工具：[app-initial-DOX-K1rC.js:171349](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:171349)。
4. 工具被加入动态工具列表，并可包装进 `codex_app` namespace：[app-initial-DOX-K1rC.js:457250](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:457250)、[app-initial-DOX-K1rC.js:457291](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:457291)。
5. app-server 的 `item/tool/call` 被转给对应 conversation：[app-initial-DOX-K1rC.js:77724](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:77724)。
6. 宿主执行该工具时校验本地主机和 feature，再调用 Primary Runtime `loadDependencies`：[app-initial-DOX-K1rC.js:457478](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:457478)、[app-initial-DOX-K1rC.js:462430](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:462430)。

### 3.3 Codex App Tools MCP/Native Pipe 链

参考项目也包含一条把宿主动态工具投影为本地 MCP 的兼容链：

- Pipe 接收 `tools/list`、`tools/call`、`tools/cancel`，带 thread/turn/call/namespace/tool 元数据：[main-Cwjv9Ibf.js:12017](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:12017)。
- Pipe 只把允许 namespace 中的工具展开成 MCP tools：[main-Cwjv9Ibf.js:12103](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:12103)。
- 启动 Pipe 时复用 `callDynamicAppTool` 和 `requestDynamicToolsForThreadStart`：[main-Cwjv9Ibf.js:133626](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:133626)。
- `codex-app-tools/server.mjs` 把 stdio MCP list/call/cancel 转发到 Native Pipe：[server.mjs:28024](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/external/plugins/openai-bundled/plugins/codex-app-tools/server.mjs:28024)。
- bundled descriptor 把插件标记为 `installWhenMissing`：[src-PzwkD6WC.js:15436](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:15436)。

静态证据的限制也必须进入计划：随包 `.mcp.json` 的 `enabled` 初始为 `false`，见 [.mcp.json:7](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/external/plugins/openai-bundled/plugins/codex-app-tools/.mcp.json:7)；当前提取物中 `setDynamicAppToolsPipePath` 的函数体为空，见 [main-Cwjv9Ibf.js:113108](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:113108)。因此“参考项目如何最终激活 MCP 配置”不能仅凭静态包认定。实施必须先做定向运行证据，再选择唯一激活源，禁止同时由插件和 main 注入两个 `codex_app`。

### 3.4 Primary Runtime、提示词和插件

- Runtime 管理器提供 diagnose/load/install/repair/cancel/update：[main-Cwjv9Ibf.js:96269](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96269)。
- Runtime 只在路径、bundle version 和依赖完整校验后报告已安装：[src-PzwkD6WC.js:31476](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31476)。
- 解压验证归档条目没有逃逸目标目录：[src-PzwkD6WC.js:31610](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31610)。
- 工作区依赖提示只在能力存在时指导模型调用工具：[src-PzwkD6WC.js:52399](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:52399)。

### 3.5 参考文件完整性

| 文件 | SHA256 |
| --- | --- |
| `.vite/build/main-Cwjv9Ibf.js` | `f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e3e0bef4556264a515f70ef3a` |
| `.vite/build/src-PzwkD6WC.js` | `63a92f6c811355a447bb65029b4963f7552ed31607de88858e494da1c995a4f5` |
| `webview/assets/app-initial-DOX-K1rC.js` | `3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4` |
| `external/.../codex-app-tools/server.mjs` | `2a5a64f192b672261e9bb22ebf2a84d550714ba002f58e5a89eeeaca951da222` |
| `external/.../codex-app-tools/.mcp.json` | `559df556a073ac3f1a014e4cadf62c4e8a49bb3164186061e478275926c815c1` |
| `external/.../codex-app-tools/.codex-plugin/plugin.json` | `932709a16f0547f47253110f7c75cc36275f832c221f5524416c3b536cc8b733` |

## 4. 当前代码基线和明确缺口

当前重构提供了正确的落点：

- main 持有共享 app-server connection 和 `HostCodexConnection`：[index.ts:165](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/index.ts:165)。
- `CodexRunDriverInput` 已有 `onDynamicToolCall`，但没有动态工具描述快照：[CodexRunDriver.ts:34](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/CodexRunDriver.ts:34)。
- `NativeCodexRunDriver` 已路由 `item/tool/call`：[NativeCodexRunDriver.ts:388](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/NativeCodexRunDriver.ts:388)。
- AI-free client 已有中性的 `DynamicToolsDispatcher`，支持定义/handler 注册、`params.tool` 兼容解析、超时和协议结果归一化，不能在 main 再造一套同职责 dispatcher：[dynamic-tools.ts:23](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/dynamic-tools.ts:23)、[dynamic-tools.ts:73](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/dynamic-tools.ts:73)、[dynamic-tools.ts:119](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/dynamic-tools.ts:119)。
- `threadStartParams()` 当前只给 ephemeral thread 写入空数组，普通 thread 没有发布动态工具：[NativeCodexRunDriver.ts:543](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/NativeCodexRunDriver.ts:543)。
- 生成协议已包含 `ThreadStartParams.dynamicTools`：[ThreadStartParams.ts:62](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadStartParams.ts:62)。
- `ThreadResumeParams` 没有该字段：[ThreadResumeParams.ts:29](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadResumeParams.ts:29)。
- 当前动态工具 handler 只处理 `read_thread_terminal`，并读取 `toolName/name`；真实协议字段是 `tool`：[codexChatRuntimeService.ts:2266](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexChatRuntimeService.ts:2266)、[DynamicToolCallParams.ts:6](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/DynamicToolCallParams.ts:6)。
- 提示词 composer 已支持 capability 和 available tool names，只缺真实快照接入：[composeCodexDesktopInstructions.ts:17](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/developerInstructions/composeCodexDesktopInstructions.ts:17)。
- AI-free catalog client 已支持 `plugin/install`、`plugin/installed` 和 `mcpServerStatus/list`：[context-catalog-client.ts:555](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts:555)、[context-catalog-client.ts:948](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts:948)、[context-catalog-client.ts:966](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts:966)。

因此缺口不是 provider 透传，而是以下四项：

1. main-owned 工具注册表和每个新 thread 的描述快照；
2. `CodexRunDriver → NativeCodexRunDriver → thread/start.dynamicTools` 的传递；
3. Primary Runtime、Native Pipe、bundled plugin 与能力状态的统一生命周期；
4. 同一工具注册表的原生投影和 MCP/Pipe 投影。

## 5. 目标架构

### 5.1 宿主能力运行时

新增一个由 Electron main 唯一持有的 `DesktopHostCapabilityRuntime`：

```text
DesktopHostCapabilityRuntime
  ├─ PrimaryRuntimeService
  ├─ DynamicAppToolRegistry                 ← 唯一工具真相源
  │    ├─ NativeDynamicToolProjection       → thread/start.dynamicTools
  │    └─ NativePipeToolProjection          → tools/list/tools/call/tools/cancel
  ├─ AI-free DynamicToolsDispatcher adapter  ← 复用现有中性协议执行器
  ├─ CodexAppToolsNativePipeServer
  ├─ CodexAppToolsMcpBridge
  ├─ BundledPluginManager
  └─ DesktopCapabilityService
```

`DynamicAppToolRegistry` 的条目至少包含：

```ts
type DynamicAppToolDefinition = {
  namespace: 'codex_app'
  name: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
  exposure: { native: boolean; pipe: boolean }
  availability(context: DesktopToolContext): Promise<ToolAvailability>
  execute(context: DesktopToolContext, args: unknown, signal: AbortSignal): Promise<unknown>
}
```

规则：

- 注册时检查 namespace/name 唯一性；schema 和描述只有一个来源。
- 原生投影生成 app-server `DynamicToolSpec[]`；Pipe 投影生成参考协议的 tools/list 结构。
- main registry 持有业务定义和 availability；现有 AI-free `DynamicToolsDispatcher` 继续持有中性的协议解析、超时、执行和结果归一化。两条入口都把调用正规化为同一协议参数后进入这个 dispatcher，不在 main 新建第二套同名执行器。
- 为支持完整复刻，只在 AI-free dispatcher 内补齐 namespace key、外部 AbortSignal 和显式 unregister/snapshot 接口；该包不能反向依赖 Electron、renderer、Primary Runtime 或其他 desktop 模块。
- `load_workspace_dependencies` 无参数、只读、只支持 local host；远程 host 返回明确不支持。
- `read_thread_terminal` 迁入同一注册表，避免保留第二个写死的 switch。
- handler 不接触 renderer payload；工具定义和可用性由 main 生成。

### 5.2 原生工具主链

```text
DesktopCapabilitySnapshot
  → CodexRunDriverInput.dynamicTools
  → NativeCodexRunDriverInput.dynamicTools
  → thread/start.dynamicTools
  → app-server item/tool/call { threadId, turnId, callId, namespace, tool, arguments }
  → AI-free DynamicToolsDispatcher + main registry handler
  → tool handler
  → DynamicToolCallResponse
```

实现要求：

- `CodexRunDriverInput` 和 `NativeCodexRunDriverInput` 使用生成协议的 `DynamicToolSpec`/`DynamicToolCallParams` 类型，不复制手写结构。
- 普通新 thread 传入本次能力快照；ephemeral thread 默认 `[]`，除非调用方显式选择允许的只读工具。
- resume 不尝试写入协议不存在的 `dynamicTools`。新能力、新插件或新 Runtime 版本只对新 thread 发布。
- 现有 thread 调用已登记工具但 Runtime 后来失效时，返回稳定降级结果；不能执行过期路径。
- 修正 handler 对 `params.tool`、`params.namespace` 和 `params.arguments` 的解析，并用协议级测试锁住。

### 5.3 MCP/Native Pipe 兼容链

```text
codex app-server / MCP client
  → codex_app stdio MCP server.mjs
  → CODEX_APP_TOOLS_PIPE_PATH
  → CodexAppToolsNativePipeServer
  → NativePipeToolProjection / AI-free DynamicToolsDispatcher
  → 同一 tool handler
```

Native Pipe 要求：

- 4-byte little-endian 长度前缀；单 frame 最大 8MiB。
- 只接受 `tools/list`、`tools/call`、`tools/cancel`。
- request/response 以 socket client 与 JSON-RPC id 双重隔离；不同 client 使用相同 id 不能串线。
- cancel 只能终止同 client、同 call；连接断开、turn 结束、应用退出都触发 AbortSignal。
- Unix socket 位于 mode `0700` 的应用私有临时目录，socket mode `0600`；Windows Named Pipe 仅当前用户 ACL。
- hardened macOS 发布版加入窄 N-API peer authorizer；未完成时只能内部验证，不能通过公开发布门禁。

MCP 激活采用证据驱动的唯一来源：

1. 先在定向运行测试中安装参考 bundled plugin，读取 `plugin/installed`、`config/read`、`mcpServerStatus/list`，确认 app-server 是否会把初始 `enabled:false` 转成活动 server。
2. 如果插件生命周期已产生唯一活动 `codex_app`，沿用该路径，main 只提供受控 Pipe/Runtime 环境。
3. 如果参考私有 setter 的激活机制在本项目不可用，则由 main 在 `NativeCodexRunDriver` 的 thread config 中合并唯一 `mcp_servers.codex_app`；这是明确记录的等价适配，不经过 provider。
4. 两种来源不能同时启用；启动时和测试中断言 `codex_app` 实例数恰好为 1。

若采用 main-owned config fallback，新增独立的 `DesktopThreadConfigSource`；它只允许合并受控 `mcp_servers.codex_app`，与 `customModelConfig()` 的 `model_providers` 做深层无覆盖合并。renderer 和请求 body 无权传入该配置。

### 5.4 Primary Runtime

新增 `desktop-app/src/main/primaryRuntime/`：

- `primaryRuntimeTypes.ts`：release/runtime manifest、diagnostic、progress 和状态机。
- `PrimaryRuntimeLocator.ts`：开发 override、app-owned cache、packaged bootstrap root 的有序定位。
- `PrimaryRuntimeDiagnostics.ts`：平台/架构、文件、执行权限、关键包和路径逃逸校验。
- `PrimaryRuntimeInstaller.ts`：下载、摘要、安全解压、staging、原子切换、取消、回滚和清理。
- `PrimaryRuntimeReleaseProvider.ts`：只从 main 的可信配置提供 release descriptor。
- `PrimaryRuntimeService.ts`：`diagnoseDependencies`、`loadDependencies`、`install`、`repair`、`cancelInstall`、`getUpdateStatus`、`runUpdateNow`、`dispose`。
- `workspaceDependencyInstructions.ts`：生成稳定、可测试的工具文本结果。

路径优先级：

1. 只在开发/测试允许的 `DASCOWORK_PRIMARY_RUNTIME_ROOT` 绝对路径；
2. 应用管理的 cache active root；
3. 将来若携带 bootstrap Runtime，则使用 `process.resourcesPath` 下只读 root。

禁止把 `/Applications/ChatGPT.app`、参考产品 cache 或系统全局 Node/Python 作为正式 fallback。

诊断必须验证：

- `runtime.json.bundleFormatVersion`、bundle version、target platform/arch；
- Node、node_modules、Python、Python packages、override/fallback bin；
- `@oai/artifact-tool` 可解析且版本符合 manifest；
- Presentations 所需的 LibreOffice/Poppler 等声明和可执行文件；
- 所有返回路径 `realpath` 后仍在选定 Runtime root 内。

安装必须满足：可信 HTTPS release source allowlist、size+SHA256、逐条目路径穿越检查、版本化 staging、全量诊断后原子激活、保留最后健康版、可取消、崩溃恢复、单飞安装、更新抖动与退避。下载不得阻塞应用主启动。

### 5.5 Bundled Plugin 管理

新增 `desktop-app/src/main/bundledPlugins/`，以数据驱动 descriptor 管理：

- `openai-bundled/codex-app-tools`：`installWhenMissing=true`、内部隐藏、参与 Pipe/MCP 兼容能力。
- `openai-primary-runtime/*`：从健康 Runtime 的 `runtime.json.bundledPlugins` 发现；Presentations、Documents、PDF、Spreadsheets 使用同一 reconcile 流程。

必须复用 AI-free [context-catalog-client.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts:555) 和共享 `HostCodexConnection` lease，不在 main 手写 plugin cache，不调用 provider fork。

reconcile 包含：资源/manifest/SHA 校验、缺失安装、版本比较、禁用恢复、安装后回读确认、失败回滚、有界重试、skills/plugin/MCP/capability cache 失效。内部插件继续从普通 UI 隐藏。

### 5.6 能力快照和提示词

`DesktopCapabilityService` 返回不可变快照：

```ts
type DesktopCapabilitySnapshot = {
  revision: string
  hostId: 'local'
  dynamicTools: readonly DynamicToolSpec[]
  availableToolNames: readonly string[]
  nativeTools: 'ready' | 'degraded' | 'unavailable'
  codexAppMcp: 'ready' | 'degraded' | 'unavailable'
  primaryRuntime: 'ready' | 'missing' | 'broken' | 'unsupported'
  bundledPlugins: 'ready' | 'degraded' | 'unavailable'
}
```

- developer instructions、`dynamicTools` 和可选 MCP config 必须来自同一 revision。
- `workspaceDependencies` 提示出现的最低条件是：feature enabled、原生工具已进入本次快照、handler 可执行。MCP/Pipe 健康是完整复刻状态的一部分，但不是原生工具提示的前置条件。
- 提示词只指导模型先调用工具，不嵌入 Runtime 绝对路径。
- Runtime/插件/Pipe 状态变化时产生新 revision；已有 thread 保持原工具目录，新 thread 使用新 revision。

## 6. 启动与关闭顺序

把 [index.ts:564](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/index.ts:564) 的启动改成可等待但不等待网络下载的 bootstrap：

1. 读取 main-only feature/release/资源配置。
2. 创建 shared app-server connection 和 `HostCodexConnection`，完成版本探测及唯一 initialize。
3. 创建 `PrimaryRuntimeService`，执行快速本地诊断。
4. 创建 registry，注册 `read_thread_terminal` 和 `load_workspace_dependencies`。
5. 生成第一版 capability snapshot。
6. main 启动 Pipe 并准备受控 env/path；生产环境只能由 app-server 通过 Phase 0 确定的唯一 MCP 配置或插件生命周期启动 `server.mjs`。main 只允许在隔离集成测试中直接拉起该进程。
7. 创建 AI-free catalog client、plugin manager 和聊天 runtime；聊天 runtime 接收 capability runtime，而不是 provider 配置。
8. 后台 reconcile bundled/runtime plugins；完成后刷新 capability revision，新 thread 使用新版本。
9. 后台检查 Runtime 更新；安装或更新不阻塞普通聊天。

关闭按相反依赖顺序：停止新工具调用 → abort pending calls → 停 plugin/runtime 更新 → 关闭聊天和 catalog leases → 关闭 MCP/Pipe → 删除 socket → 关闭 shared app-server connection。接入现有 [index.ts:1052](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/index.ts:1052) 的 `before-quit`。

## 7. 分阶段实施

### Phase 0：锁定重构后边界和参考激活证据

1. 把本计划对应 ADR 写入 `docs/adr/`，记录双投影、唯一 registry、Native driver 主路径和 provider 禁入决定。
2. 为 `DynamicToolCallParams.tool`、`ThreadStartParams.dynamicTools`、`ThreadResumeParams` 无 dynamicTools 写协议契约测试。
3. 扩展 native boundary verifier，禁止 main 重新引入 provider 或创建第二套 app-server client。
4. 建立定向参考运行/本地等价实验：安装 `codex-app-tools` 后读取 config、plugin installed、MCP status，确定唯一 MCP 激活源；保存脱敏证据。
5. 记录静态证据不能证明的部分，不把 `setDynamicAppToolsPipePath` 空实现推断成真实执行机制。

**Phase 0 完成条件**：协议字段、生产所有者和 MCP 唯一激活源均有自动化证据；不存在“实施时再决定由 provider 还是 Native driver 接线”的开放分支。

### Phase 1：建立统一工具注册表和原生主链

1. 新建 `desktop-app/src/main/appTools/` 下的 registry、两个 projection、desktop context adapter 和 tool definitions；不新增与 AI-free `DynamicToolsDispatcher` 重复的执行器。
2. 扩展现有 `vendors/codex-app-server-client/src/dynamic-tools.ts` 的中性契约，补齐 namespace、AbortSignal、快照注册/释放，并保持无 Electron/desktop 依赖。
3. 把 `read_thread_terminal` 从 `CodexChatRuntimeService` 的写死分支迁入 registry，通过 AI-free dispatcher 执行，并修正 `params.tool` 解析。
4. `CodexRunDriverInput`、`NativeCodexRunDriverInput` 增加不可变 `dynamicTools` 快照。
5. `threadStartParams()` 把普通新 thread 的快照写入 `dynamicTools`；resume 不写；ephemeral 默认空。
6. 用 echo/abort fixture 锁住工具发布、调用、错误、取消和结果格式。

**Phase 1 完成条件**：真实 app-server fixture 收到动态工具描述，并通过 `item/tool/call` 调到 main registry；`read_thread_terminal` 行为不回归。

### Phase 2：实现 `load_workspace_dependencies` 和 fixture Runtime，完成里程碑 A

1. 建立最小 Runtime fixture，包含 runtime manifest、假 Node/Python/package/bin 路径和 `@oai/artifact-tool` 标记。
2. 实现只读、无参数、local-only 的 `load_workspace_dependencies` definition/handler。
3. handler 每次调用重新向 Runtime service 取健康路径，不缓存绝对路径到 thread/prompt。
4. 输出参考项目同等字段：bundle version、Node、Node packages、Python、Python packages、override/fallback binaries，以及存在时的 Git/pnpm。
5. 覆盖 disabled、missing、broken、unsupported、非空参数、remote host 和 aborted 调用。

**里程碑 A 完成条件**：`thread/start.dynamicTools → item/tool/call → registry → fixture Runtime` 返回真实受控路径；失败状态稳定且不泄露内部堆栈。

### Phase 3：完成 Primary Runtime 生命周期

1. 实现 locator、manifest parser、diagnostics、状态机和 main-only release source contract。
2. 实现下载、size/SHA 校验、安全解压、staging、全量诊断、原子激活、取消和回滚。
3. 实现 repair/reset、更新检查、退避轮询、磁盘预检和崩溃恢复。
4. 支持显式开发 Runtime root；只读且不复制/修改用户指定目录。
5. 用小型 fixture archive 覆盖成功、截断、SHA 错误、路径穿越、symlink/hardlink 逃逸、平台不匹配、空间不足、安装中崩溃和回滚。

**Phase 3 完成条件**：从可信 fixture release 可安装并激活；旧健康版在新版本诊断通过前始终可用；无网络时仍选择最后健康版本。

### Phase 4：固定 Codex App Tools 资源并建立 bundled plugin manager

1. 只复制参考 `codex-app-tools` 所需文件到 `desktop-app/resources/bundled-plugins/openai-bundled/`，不复制整个 `external/`。
2. `bundle-lock.json` 记录参考版本、来源相对路径、文件 SHA、插件版本和复制日期；同步脚本只接受显式 `--source`。
3. build/CI 验证 allowlist、SHA、多余/缺失文件、launcher 权限和 packaged layout。
4. `electron-builder.yml` 用 `extraResources` 放到 `process.resourcesPath/plugins/**`，不依赖 `reference-projects`。
5. 实现 `BundledPluginManager`，通过 AI-free catalog client 完成 installWhenMissing、版本比较、恢复启用、回读和缓存失效。
6. 保持 `codex-app-tools` 内部隐藏；公开发布工作流验证 proprietary 分发授权。

**Phase 4 完成条件**：空测试 `CODEX_HOME` 启动后插件被幂等安装/恢复且不出现在普通 UI；打包产物中只有 allowlist 文件且 SHA 正确。

### Phase 5：Native Pipe 和真实 `server.mjs`，完成里程碑 B

1. 实现 frame codec、socket/Named Pipe server、client 隔离、定向响应、取消和生命周期。
2. Pipe 的 list 使用 Phase 1 registry，call/cancel 进入同一个 AI-free dispatcher 和 main handler，不复制工具描述、Map 或执行状态。
3. 真实 `server.mjs` 完成 MCP initialize/list/call/cancel/shutdown。
4. 按 Phase 0 证据选择唯一 MCP 激活源；需要 main config fallback 时在 Native driver 合并，不经过 provider。
5. 用同一参数分别走原生链和 Pipe/MCP 链，归一化后结果完全一致。
6. 增加 macOS peer authorizer/Windows ACL 发布门禁和私有 socket 清理。

**里程碑 B 完成条件**：真实 `server.mjs` 经 Pipe 调用同一 handler；并发、取消、8MiB 限制和退出清理通过；app-server 观察到恰好一个 `codex_app`。

### Phase 6：能力快照、提示词和降级一致性

1. 实现 `DesktopCapabilityService` revision 快照，把同一快照同时交给提示词 composer、Native driver 和诊断。
2. `CodexChatRuntimeService` 组装提示词时传入 `capabilities` 和 `availableToolNames`。
3. 为新 thread、resume、retry、Runtime 更新、插件安装、Pipe 故障建立状态矩阵。
4. 新能力只对新 thread 发布；UI/诊断明确提示“新任务生效”。
5. 错误码区分 bundle 损坏、Pipe/MCP 失败、Runtime missing/broken/unsupported、feature disabled；renderer 不看到凭据、Pipe 路径或下载 URL。

**Phase 6 完成条件**：提示词、动态工具目录和实际 handler 可用性没有互相矛盾；任何降级都不会出现“提示存在但工具不存在”。

### Phase 7：同步 Primary Runtime marketplace，完成里程碑 C

1. 从健康 Runtime 的 manifest 发现 `openai-primary-runtime` marketplace。
2. 用同一 BundledPluginManager 安装/升级 Presentations、Documents、PDF、Spreadsheets 等 descriptor；不为 Presentations 写专用 installer。
3. 安装后通过 `plugin/installed`、skills list 和来源路径回读确认。
4. Runtime 切换版本时刷新 catalog/skills/capability cache；现有 thread 不热换，新 thread 获取新版本。
5. 增加第二个内部插件 fixture，证明平台不是 Presentations 专用。

**里程碑 C 完成条件**：新 thread 能发现当前 active Runtime 中的 Presentations skill；二次启动幂等；旧 Runtime 插件不会被误报成 active。

### Phase 8：Presentations 真实闭环，完成里程碑 D

1. 准备固定 HTML 和本地素材，使用确定性输出目录，不引入外部图片/connector 变量。
2. 从真实聊天发送固定任务，记录 thread/start、tool call、command item、artifact 和最终文件证据。
3. 断言 `load_workspace_dependencies` 至少调用一次，返回路径属于 active Runtime。
4. 断言 authoring 使用返回的 Runtime Node 和 `@oai/artifact-tool`；禁止 `python-pptx`、手写 OOXML/zip 和系统全局 Node modules fallback。
5. 断言 Presentations skill 的 artifact-operation marker 在首次写操作前执行。
6. 验证 PPTX zip、`[Content_Types].xml`、`ppt/presentation.xml`、slide 数量和关系文件。
7. 使用 Runtime 自带渲染/slide test 工具生成 PNG，检查结构错误和文本溢出；保存 montage 供人工复核。
8. 如果 Artifact/PPTX preview 已合入，增加生成后打开 Artifact tab smoke；否则验证文件卡/链接可打开，不越界重做预览计划。

**里程碑 D 完成条件**：真实会话可重复生成可打开、可渲染、无溢出的 PPTX，且事件证据证明使用标准 Runtime/skill/tool 链；packaged app 得到同样结果。

### Phase 9：打包、发布门禁和最终复刻审计

1. macOS、Windows、Linux 至少完成各自可运行平台的资源定位、Pipe/ACL 和 Runtime 路径 smoke；无法获得的平台明确列为发布阻塞，不虚报通过。
2. 公开发布门禁验证：bundle 授权、bundle SHA、peer authorization、可信 Runtime feed、代码签名和退出清理。
3. 用参考行为矩阵逐项对照 native tools、Pipe/MCP、Runtime、plugin、prompt 和 Presentations；每项关联测试证据。
4. 运行 native boundary/protocol/real app-server checks，确认没有修改 app-server、没有 provider 回流、没有第二个 initialize 所有者。
5. 输出复刻差异清单；只允许明确记录且有等价测试的实现差异，不允许能力或安全差异。

**完整复刻完成条件**：第 8 节所有验收项通过，差异清单中没有未解释的行为差异；若授权、peer authorization 或平台 smoke 未通过，只能标记为“内部工程复刻完成”，不能标记为“可发布完整复刻”。

## 8. 可测试验收标准

### 8.1 原生动态工具

- **AC-01**：新 thread 的 `thread/start.dynamicTools` 包含且只包含该 capability revision 允许的工具；ephemeral 默认空。
- **AC-02**：resume payload 不伪造 `dynamicTools`；安装/更新后的新工具只有新 thread 可见。
- **AC-03**：`item/tool/call` 按生成协议的 `tool/namespace/arguments` 字段路由；错误字段和未知工具稳定失败。
- **AC-04**：`read_thread_terminal` 迁移后现有成功、不可用、无终端行为不回归。
- **AC-05**：`load_workspace_dependencies` 原生调用成功返回 fixture/active Runtime 路径；参数非 `{}`、remote host、取消分别失败。

### 8.2 Registry 与双投影

- **AC-06**：同名 namespace/tool 重复注册在启动时失败；原生和 Pipe 描述来自同一 definition。
- **AC-07**：同一调用经原生链和 MCP/Pipe 链的归一化结果、错误码和取消语义一致。
- **AC-08**：第二个 fixture 工具无需修改 Native driver、Pipe server 或 AI-free dispatcher 核心逻辑即可被两条链发现和调用；代码检查不存在第二个动态工具 handler Map。
- **AC-09**：任意时刻活动 `codex_app` MCP server 数量为 0 或 1，永不为 2；ready 状态下必须恰好为 1。

### 8.3 Bundle、MCP 与 Pipe

- **AC-10**：任改 `server.mjs` 1 byte、缺文件或出现 allowlist 外文件，bundle verifier 失败。
- **AC-11**：unpacked/packaged app 中插件位于 `process.resourcesPath/plugins/**`，SHA 正确且不依赖 `reference-projects`。
- **AC-12**：fragmented/coalesced/zero/invalid/>8MiB frame，非法 JSON-RPC method 都有测试。
- **AC-13**：两个 client 使用相同 request id 不串线；一个 client 不能取消另一个 client 的 call。
- **AC-14**：真实 `server.mjs` 完成 initialize/list/call/cancel/shutdown；缺 Pipe env 时给出明确连接错误。
- **AC-15**：退出后 Pipe 不接受连接、socket 已删除、pending handler 全部 aborted。

### 8.4 Primary Runtime 与插件

- **AC-16**：健康 fixture 返回 installed/ready 和全部绝对路径；缺 artifact-tool、错误 arch、逃逸 symlink 或不可执行 Node 时 broken。
- **AC-17**：SHA 错误、截断、路径穿越、取消和崩溃不会替换 active Runtime，也不残留可选 staging。
- **AC-18**：Runtime 升级在新版本全量诊断通过后才原子切换；失败继续使用最后健康版。
- **AC-19**：空测试 `CODEX_HOME` 自动安装 `codex-app-tools`；二次启动幂等；内部插件不能从普通 UI 卸载。
- **AC-20**：Runtime marketplace 同步后 skills list 发现 Presentations；来源路径属于 active Runtime。
- **AC-21**：新增第二个 runtime plugin descriptor 无需修改 installer 或 UI service。

### 8.5 提示词与 Presentations

- **AC-22**：feature、工具发布、handler 可用性任一不满足时，不注入 Workspace Dependencies 提示。
- **AC-23**：能力可用时提示 section 只出现一次；retry/resume 不重复，Runtime 路径不写入提示词。
- **AC-24**：真实聊天记录出现原生 `load_workspace_dependencies` 调用；兼容链测试另行证明同一工具可经 `codex_app` MCP 调用。
- **AC-25**：生成命令使用 active Runtime Node 和 `@oai/artifact-tool`，测试拒绝所有禁止 fallback。
- **AC-26**：最终 PPTX 结构、渲染和 overflow test 全部通过，文件位于宿主允许目录。

### 8.6 架构与安全

- **AC-27**：native boundary verifier 证明 main/renderer/preload 无 provider 生产依赖、无任意 app-server IPC bridge。
- **AC-28**：renderer 无法提交 MCP command/env、Runtime URL/root、Pipe path 或动态工具 schema。
- **AC-29**：共享 Host connection 每代只 initialize 一次；插件协调和状态读取只通过 lease。
- **AC-30**：公开 release 在 proprietary 授权、peer authorization、trusted feed 或 bundle lock 任一缺失时失败关闭。
- **AC-31**：app-server 源码无改动；协议 manifest、真实 binary contract 和桌面 E2E 同时通过。

## 9. 测试与验证矩阵

| 层级 | 新增/修改测试 | 证明内容 |
| --- | --- | --- |
| Protocol contract | AI-free client protocol/verifier tests | `dynamicTools`、`DynamicToolCallParams.tool`、resume 边界 |
| Registry unit | `desktop-app/src/main/appTools/*.test.ts`、AI-free `dynamic-tools.test.ts` | 唯一性、schema、availability、中性 dispatcher、两种投影一致性 |
| Native driver | `NativeCodexRunDriver.test.ts`、`CodexRunDriver.test.ts` | 新 thread 发布、resume/ephemeral、server request routing |
| Chat runtime | `codexChatRuntimeService.test.ts` | capability revision、提示词、工具执行、retry/resume |
| Pipe unit | `appTools/nativePipe*.test.ts` | frame、隔离、cancel、ACL/mode、shutdown |
| MCP integration | `desktop-app/src/main/appTools/bundledAppToolsCompatibility.test.ts` | 真实 server.mjs ↔ Pipe ↔ registry |
| Runtime unit | `desktop-app/src/main/primaryRuntime/*.test.ts` | manifest、路径、诊断、状态机、指令格式 |
| Runtime installer | `desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.test.ts`、`PrimaryRuntimeService.test.ts` | SHA、安全解压、激活、回滚、取消、恢复 |
| Bundled plugins | `BundledPluginManager.test.ts`、`BundledPluginReconcileCoordinator.test.ts` | installWhenMissing、幂等、升级、失败恢复、内部隐藏 |
| Electron E2E | 尚未交付的 `desktop-app/tests/e2e/app-tools-host.e2e.ts` | renderer → main → Native driver → app-server → registry |
| Packaged smoke | `desktop-app/scripts/run-packaged-app-tools-smoke.mjs` | extraResources、Runtime、MCP/Pipe、退出清理 |
| Deterministic Runtime smoke | `desktop-app/scripts/run-presentations-runtime-smoke.mjs` | 真实 Runtime/skill/artifact-tool、PPTX、渲染和 overflow 证据；不冒充真实聊天 |
| Live LLM smoke | 尚未交付的独立 opt-in gate | 真实聊天中的 skill、load tool、command item、artifact 和最终文件事件证据 |

阶段验证命令：

```text
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:real-codex-app-server-contract
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run test:unit
# 待 E2E 文件交付后启用：npm --prefix desktop-app run test:e2e -- tests/e2e/app-tools-host.e2e.ts --reporter=line
npm --prefix desktop-app run build:unpack
DASCOWORK_PACKAGED_APP_TOOLS_SMOKE=1 DASCOWORK_PACKAGED_RESOURCES_PATH=/absolute/resources/path DASCOWORK_PACKAGED_EXECUTABLE=/absolute/electron/path npm --prefix desktop-app run smoke:packaged-app-tools
DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT=/absolute/runtime/path npm --prefix desktop-app run test:primary-runtime-real
DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE=1 DASCOWORK_PRIMARY_RUNTIME_ROOT=/absolute/runtime/path DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE_OUTPUT_DIR=/absolute/evidence/path npm --prefix desktop-app run smoke:presentations-runtime
```

Deterministic Runtime smoke 与 Live Presentations smoke 必须分开命名、分开验收。前者保存 Runtime、skill、artifact-tool、PPTX 结构、渲染和 overflow 证据；后者必须另外保存脱敏的真实聊天 tool-call、command item 和最终 artifact 事件证据。前者和普通单元测试都不能代替后者。

## 10. 文件改造清单

### 10.1 新增

- `docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md`
- `desktop-app/resources/bundled-plugins/openai-bundled/**`
- `desktop-app/scripts/sync-codex-app-tools-bundle.mjs`
- `desktop-app/scripts/verify-bundled-plugins.mjs`
- `desktop-app/scripts/run-packaged-app-tools-smoke.mjs`
- `desktop-app/scripts/run-presentations-runtime-smoke.mjs`
- `desktop-app/scripts/run-primary-runtime-real-smoke.mjs`
- 独立 Live Presentations gate（尚未交付，不得用 deterministic smoke 替代）
- `desktop-app/src/main/appTools/**`
- `desktop-app/src/main/primaryRuntime/**`
- `desktop-app/src/main/bundledPlugins/**`
- `desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts`
- 对应 unit/integration/E2E fixtures 和 tests

### 10.2 修改

- `desktop-app/electron-builder.yml`
- `desktop-app/package.json`
- `desktop-app/src/main/index.ts`
- `desktop-app/src/main/runtimeConfig.ts`
- `desktop-app/src/main/codexRun/CodexRunDriver.ts`
- `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts`
- `desktop-app/src/main/codexChatRuntimeService.ts`
- `desktop-app/src/main/developerInstructions/composeCodexDesktopInstructions.ts` 及测试
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`，仅接 cache invalidation、内部隐藏和诊断；自动安装不塞进 UI service
- `desktop-app/vendors/codex-app-server-client/src/**`，仅在需要导出已生成类型或补充 AI-free client 能力时修改
- `desktop-app/scripts/verify-codex-native-runtime-boundaries.mjs` 及测试

### 10.3 明确不修改

- `desktop-app/src/main/codexAspProvider.ts`：文件已经不存在，不重建。
- `desktop-app/vendors/ai-sdk-provider-codex-asp/**`：不用于桌面生产能力；除非单独发现兼容包回归，本计划不改。
- `codex/codex-rs/app-server/**`、`codex/codex-rs/core/**`。
- renderer 的 Node/Electron 安全边界。
- 独立 Artifact/PPTX 预览实现；只在最终阶段接联动 smoke。

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 把 dynamicTools 与 MCP/Pipe 再次串成单链 | 任一兼容组件失败会误伤主能力 | 一个 registry、两个投影、分别验收；提示词只依赖原生主链 |
| MCP 激活来源在静态参考中不完整 | 可能重复启动或偏离参考 | Phase 0 定向运行证据；唯一激活源；ready 时实例数=1 |
| `server.mjs` 为 Proprietary | 无权公开分发 | 内部 SHA 固定；release 授权门禁；准备同契约 clean-room 替代路线 |
| Pipe 只有随机路径/0600 | 同用户恶意进程可能抢连 | peer authorizer、Windows ACL、私有目录、client 隔离；未完成不公开发布 |
| capability snapshot 与 Runtime 状态竞态 | 提示存在但调用失败 | 不可变 revision；新 thread 单次取快照；handler 每次重新检查 Runtime |
| resume 看不到新工具 | 用户误以为安装失败 | 产品明确提示“新任务生效”；测试锁住 thread-start-only 语义 |
| model config 与 MCP config 覆盖 | custom model provider 配置丢失 | main-only 深层无覆盖合并；碰撞直接失败并记录诊断 |
| Runtime 大且下载易失败 | 首次使用慢、磁盘压力 | 后台下载、进度、取消、SHA、磁盘预检、原子激活、保留健康版 |
| release feed 未定义 | 正式安装缺可信来源 | main-only release source contract；fixture 先行；公开发布前必须接签名/授权 feed |
| Live LLM 随机性 | CI 偶发失败 | 核心链确定性测试；live smoke 独立、可重试、保存事件证据 |
| Presentations 自行 fallback | 文件存在但未走标准链 | 同时断言 tool、Runtime Node、artifact-tool 和禁止项 |

## 12. 提交边界

建议保持以下可回滚提交，不把大 bundle 与业务代码混在同一提交：

1. `docs: rebase app tools parity plan on native runtime`
2. `test: lock dynamic tool protocol contracts`
3. `feat: add host tool registry and native projection`
4. `feat: implement workspace dependency tool and runtime diagnostics`
5. `feat: manage primary runtime lifecycle`
6. `chore: pin codex-app-tools bundled artifact`
7. `feat: reconcile bundled plugins with ai-free client`
8. `feat: add native pipe and codex_app mcp projection`
9. `feat: derive desktop instructions from capability revisions`
10. `feat: sync primary runtime skills and plugins`
11. `test: prove presentations generation and packaged parity`
12. `security: enforce app tools release gates`

## 13. 停止条件与完成定义

实施只有在以下全部成立时才能停止：

- 原生 `dynamicTools/item/tool/call` 主链和真实 `server.mjs/Native Pipe` 兼容链都使用同一 registry，并分别通过。
- `load_workspace_dependencies` 返回健康 Primary Runtime 的真实路径，失败时关闭能力且不泄露敏感信息。
- Primary Runtime 安装、诊断、更新、修复、取消、回滚和崩溃恢复有自动化证据。
- bundled plugin reconcile 使用 AI-free client，两个 marketplace 数据驱动且幂等。
- 提示词、工具目录和 handler 可用性来自同一 capability revision；新 thread/resume 语义准确。
- 真实 Presentations skill 使用 `load_workspace_dependencies + @oai/artifact-tool` 生成、渲染并验证 PPTX。
- packaged app 能定位资源、Runtime 和 Pipe，退出无残留。
- native boundary、协议、真实 app-server、unit、E2E、packaged smoke 全部通过。
- 没有修改 Codex app-server，没有把生产聊天接回 provider，没有重复 `codex_app`。
- 差异审计没有未解释的行为或安全差异。
- bundle 授权、peer authorization、可信 Runtime feed 和目标平台 smoke 全部通过后，才标记“可发布完整复刻”；否则仅标记“内部工程复刻完成”。

## 14. 本次修订摘要

- 把生产接线从已删除的 `codexAspProvider.ts` 和 provider fork 移到 `CodexRunDriver/NativeCodexRunDriver`。
- 补回参考项目真实存在的原生 `thread/start.dynamicTools → item/tool/call` 主链。
- 将 MCP/Native Pipe 改为同一 registry 的第二投影，并仍保留为完整复刻的必达里程碑。
- 新增 `params.tool` 协议修正、thread-start-only 能力快照和新任务生效规则。
- Bundled Plugin manager 改用 AI-free context client 和共享 Host lease。
- 更新文件清单、测试矩阵、提交顺序、发布门禁和停止条件。

## 15. 2026-09-07 实施审计状态

当前只能认定为“内部工程实施进行中”，不能认定里程碑 D、完整复刻或可发布完成。

已获得的真实证据：

- 原生动态工具、Native Pipe、真实 `server.mjs` 兼容调用、Runtime v2 诊断、双 marketplace 发现和内部插件隐藏均有针对性测试。
- unpacked macOS 产物可以从 `process.resourcesPath/plugins/**` 启动固定 bundle；launcher 在没有显式 Electron-as-Node 时失败关闭。
- 真实 Primary Runtime `26.904.11930` 已通过 `load_workspace_dependencies` 桌面工具调用，并发现 Presentations 和 Documents。
- deterministic Runtime smoke 使用 Runtime Node、`@oai/artifact-tool`、Presentations finalizer、Runtime renderer 和 overflow checker 生成并验证 PPTX，证据目录不会被测试自动删除。
- 动态工具调用由 main 强制绑定当前活动 thread，不能用请求里的 `threadId` 读取其他任务；超时或取消后会及时清理监听器，均有回归测试。

仍未完成、不得由 fixture 或 deterministic smoke 代替的门槛：

- 尚无真实聊天会话的 Presentations tool-call、command item 和 artifact 事件证据，因此 AC-24 与里程碑 D 未完成。
- 尚无 renderer → main → Native driver → 真实 app-server → registry 的专用 Electron E2E，因此 AC-31 的桌面 E2E 部分未完成。
- macOS peer authorizer、Windows 当前用户 ACL、Windows/Linux packaged smoke、proprietary bundle 分发授权、代码签名和正式可信 release feed 仍是公开发布阻塞。
- Runtime archive 下载和 ZIP 索引仍会占用与大归档规模相关的进程内存；在真实大包安装压力测试通过前，不得把小 fixture 安装测试解释为大 Runtime 安装能力已验收。
- 当前目录切换保留回滚和崩溃恢复，但不是单个文件系统原语完成的无窗口交换；在并发安装/读取压力测试或指针式激活完成前，不得宣称“旧健康版始终无瞬时空窗”。
- 完整 `test:unit` 最近一次共通过 2255 项，但 `App.test.tsx` 的历史 commentary replay 在全套负载下有 1 项超过默认 5 秒；同项和整个文件隔离运行均通过。没有通过提高超时或弱化断言掩盖它，因此默认全量 unit 门禁目前仍不能记为绿色。
