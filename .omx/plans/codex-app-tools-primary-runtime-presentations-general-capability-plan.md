# Codex App Tools、Primary Runtime 与 Presentations 通用能力复刻计划

日期：2026-09-03  
模式：`$plan` direct（本轮只输出计划，不修改产品源码）

## 1. 结果与关键决定

本计划把目标拆成三个连续、可单独验收的里程碑：

1. **里程碑 A：先打通最短真实链路。** 把参考项目里的 `codex-app-tools` 原样固定到客户端资源目录，用它启动真实 MCP 子进程；宿主实现 Native Pipe、`tools/list`、`tools/call` 和取消转发；先让 `load_workspace_dependencies` 从一个受控测试 Runtime/开发机 Runtime 返回真实路径。这个阶段证明“app-server → MCP → codex-app-tools → Native Pipe → Electron main → 工具结果”的链路成立。
2. **里程碑 B：把临时链路升级为通用平台。** 增加 Primary Runtime 的诊断、安装、校验、修复、更新、取消和回滚；增加 Bundled Plugin 自动安装与内部管理；能力快照只在真实可用时注入提示词；形成可扩展的宿主工具注册表和插件描述符。
3. **里程碑 C：用 Presentations 做端到端验收。** 由 Primary Runtime 安装并启用 `openai-primary-runtime/presentations`，让新会话真实调用 `load_workspace_dependencies`，再用 Runtime 中的 `@oai/artifact-tool` 把固定 HTML 内容生成 `.pptx`，完成结构、渲染和溢出校验。

核心决定如下：

- **不复制整个 `reference-projects/.../external`。** 只复制 `codex-app-tools` 所需的 5 个文件，并在客户端建立一个只含该插件的最小 `openai-bundled` marketplace。整个 `external` 还包含 Browser、Chrome、Sites 等无关私有资产，复制它们不会帮助本目标，反而扩大打包体积、许可证和供应链风险。
- **第一阶段直接使用已打包的 `server.mjs`，不把源码复原作为前置条件。** 该文件的自有桥接逻辑集中在末尾，协议边界清楚；先用固定 SHA 的 bundle 验证整条链路，之后可在同一契约测试下替换为自有可读实现。
- **保持 Codex app-server 不变。** 所有新增能力落在 `desktop-app/`、provider fork 和客户端资源层；通过 provider 已有的 `mcpServers -> thread/start.config.mcp_servers` 接缝注入 `codex_app`。
- **行为复刻优先于复制参考项目的私有宿主 API。** 参考项目通过内部 `setDynamicAppToolsPipePath` 把 Pipe 路径送入执行环境；当前项目没有这一私有接口。本项目用每个 `thread/start` 的 stdio MCP 配置显式传入 `CODEX_APP_TOOLS_PIPE_PATH`，得到相同的数据链和安全边界，同时不修改 app-server。
- **Primary Runtime 不复制进 Git。** 当前完整 Runtime 约 1.6GB，开发验证可用显式本地路径；正式环境由 Runtime 管理服务按平台下载、校验和原子安装。代码和测试不得硬编码 `/Users/nallylin`、`/Applications/ChatGPT.app` 或系统全局 Node/Python。
- **工程完成与发布完成分开。** 参考 `codex-app-tools` manifest 标注 `Proprietary`。内部链路验证可以使用用户指定的固定 bundle；对外分发前必须取得明确授权，或在同一协议测试下换成自有 clean-room MCP bridge。

## 2. 需求摘要

### 2.1 必须交付

1. 客户端仓库内有 SHA 固定、来源可追踪的 `codex-app-tools` 资源，开发和 packaged app 都能定位。
2. Electron main 启动并管理本地 Native Pipe，支持 4-byte little-endian 长度前缀、8MiB 上限、JSON-RPC 2.0、请求路由、响应定向、并发调用和取消。
3. `codex-app-tools/server.mjs` 作为真实 stdio MCP server 启动，并通过 `CODEX_APP_TOOLS_PIPE_PATH` 转发到宿主。
4. 宿主有通用工具注册表，不把 `load_workspace_dependencies` 写死在网络层；新增工具只需要增加描述符和 handler。
5. `load_workspace_dependencies` 是只读、无参数、仅本地主机可用的真实工具；返回已经校验的 Node、Node modules、Python、override/fallback binaries 和 bundle version。
6. Primary Runtime 有完整状态机：发现、诊断、缺失、下载、校验、安装、就绪、过期、修复、取消、失败、回滚。
7. Primary Runtime release manifest、下载 URL、摘要和平台信息只能由 main 的可信配置提供，renderer 和模型不能任意指定下载地址或安装路径。
8. Bundled Plugin manager 支持 `installWhenMissing`、功能开关、内部隐藏、版本比较、幂等安装、升级、失败回滚和缓存刷新。
9. Runtime 内的 `openai-primary-runtime` marketplace 能被同步，Presentations、Documents、PDF、Spreadsheets 等插件可按描述符接入；不能为每个插件再写一套安装逻辑。
10. 能力提示词来源于 main 的真实能力快照；`load_workspace_dependencies` 不存在或不可用时，不向模型声称它可用。
11. 开发、单元、集成、Electron E2E 和 packaged smoke 都有明确覆盖；应用退出会关闭 Pipe、取消调用并清理 socket。
12. 用真实 Presentations 技能和 `@oai/artifact-tool` 生成一个有效 `.pptx`，而不是退化为手写 OOXML、`python-pptx` 或系统全局依赖。

### 2.2 明确不包含

- 不修改 `codex/codex-rs/app-server/`。
- 不把整个参考项目 `external/` 目录搬进客户端。
- 不在 renderer 中直接启动进程、读任意文件、管理 Pipe 或接触 Runtime 下载凭据。
- 不把 1.6GB Primary Runtime 直接提交到 Git。
- 本计划不要求先反编译/重写 `server.mjs`；可读源码替换是后续硬化项，不阻塞里程碑 A-C。
- 本计划不重做 PPTX 预览 UI。当前工作树已有独立的 Artifact/PPTX 预览工作；本计划只要求生成产物能被现有文件/Artifact 入口发现，预览像素或批注闭环由 `.omx/plans/reference-pptx-preview-parity-plan.md` 管理。

## 3. 参考项目事实与当前缺口

### 3.1 参考链路证据

参考索引已执行完整校验：7188/7188 个文件通过，`sourceMode=beautified-fallback`。因此下列结论引用可读文件精确行号和 SHA256，不声称有 `_analysis/raw/` 排版前行列。

| 能力               | 参考证据                                                                                          | 结论                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bundled descriptor | `.vite/build/src-PzwkD6WC.js:15436-15453`                                                         | `openai-bundled/codex-app-tools` 被标为 `installWhenMissing: true`。                                                       |
| 自动安装与资源同步 | `.vite/build/main-Cwjv9Ibf.js:9864-9932`                                                          | 启动流程计算强制安装/缺失安装列表，并用 `resourcesPath`、runtime marketplace root 和 app-server connection 做同步。        |
| Plugin manifest    | `external/plugins/openai-bundled/plugins/codex-app-tools/.codex-plugin/plugin.json:2-9`           | 插件用于“通过一个本地 MCP server 暴露桌面工具”；版本 `0.1.0`，许可证 `Proprietary`。                                       |
| MCP manifest       | `external/plugins/openai-bundled/plugins/codex-app-tools/.mcp.json:2-20`                          | MCP 名为 `codex_app`，启动 `server.mjs`，启动超时 10 秒、工具超时 3600 秒。                                                |
| Node launcher      | `external/plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp:9-35` | 按显式 Runtime、应用资源、缓存 Runtime、系统 Node 的顺序寻找 Node；正式实现应优先给出显式可信 Runtime 路径。               |
| MCP → Pipe         | `external/plugins/openai-bundled/plugins/codex-app-tools/server.mjs:28024-28118`                  | MCP 的 `tools/list`/`tools/call` 通过 Native Pipe 转发，调用时携带 thread/turn/call 元数据。                               |
| Pipe 协议与取消    | 同文件 `:28173-28390`                                                                             | 从 `CODEX_APP_TOOLS_PIPE_PATH` 建连，采用 4-byte LE frame、8MiB 上限，并把 abort 变成 `tools/cancel`。                     |
| Host Pipe          | `.vite/build/main-Cwjv9Ibf.js:11715-11928,12017-12164`                                            | 宿主创建随机 Pipe、解析 frame、区分客户端、过滤命名空间、转发 list/call/cancel；Unix socket chmod `0600`。                 |
| Peer authorization | 同文件 `:11959-12005`                                                                             | macOS hardened 构建可加载 native addon 校验 socket peer；这不是普通 `node:net` 自动提供的能力。                            |
| 启动/销毁接线      | 同文件 `:133626-133641`                                                                           | 启动 Pipe 后设置动态工具 Pipe path；销毁时清空并关闭 Pipe；失败只降级工具能力，不应拖垮整个应用。                          |
| load tool 定义     | `webview/assets/app-initial-DOX-K1rC.js:171349-171357`                                            | `load_workspace_dependencies` 为只读、无参数的本地桌面工具。                                                               |
| load tool 执行     | 同文件 `:457478-457537,462430-462432`                                                             | 工具先确认本地主机和 feature，再调用 Primary Runtime `loadDependencies`，并把安装/禁用/缺失分别返回。                      |
| Runtime 诊断与管理 | `.vite/build/main-Cwjv9Ibf.js:96269-96473`                                                        | Runtime manager 暴露 diagnose、load、install、repair/reset、cancel、update poll 和安装进度广播。                           |
| Runtime 路径说明   | `.vite/build/src-PzwkD6WC.js:31476-31555`                                                         | 返回 bundle version、Node、node_modules、Python、Python packages、override/fallback bins；只有完整校验后才标记 installed。 |
| 安全解压           | 同文件 `:31610-31616`                                                                             | 解压前验证所有归档项仍在目标目录内，阻止路径穿越。                                                                         |
| 提示词             | 同文件 `:52400-52413`                                                                             | 宿主只在能力存在时提示模型先调用 `load_workspace_dependencies`。                                                           |

参考文件完整性：

| 文件                                                     | SHA256                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `.vite/build/main-Cwjv9Ibf.js`                           | `f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e3e0bef4556264a515f70ef3a` |
| `.vite/build/src-PzwkD6WC.js`                            | `63a92f6c811355a447bb65029b4963f7552ed31607de88858e494da1c995a4f5` |
| `webview/assets/app-initial-DOX-K1rC.js`                 | `3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4` |
| `external/.../codex-app-tools/server.mjs`                | `2a5a64f192b672261e9bb22ebf2a84d550714ba002f58e5a89eeeaca951da222` |
| `external/.../codex-app-tools/.mcp.json`                 | `559df556a073ac3f1a014e4cadf62c4e8a49bb3164186061e478275926c815c1` |
| `external/.../codex-app-tools/.codex-plugin/plugin.json` | `932709a16f0547f47253110f7c75cc36275f832c221f5524416c3b536cc8b733` |

### 3.2 当前项目已有接缝

- provider 已支持 `mcpServers`，并把它写入 `thread/start.config.mcp_servers`：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/provider-settings.ts:315-324`、`thread-client.ts:97-118`。
- 当前 main wrapper 没有接收或传入 `mcpServers`，只注册了 `read_thread_terminal`：`desktop-app/src/main/codexAspProvider.ts:31-42,76-118`。
- `CodexChatRuntimeService` 构造 provider 时没有宿主 MCP，组装提示词时也没传 capability/tool names：`desktop-app/src/main/codexChatRuntimeService.ts:359-370,760-763`。
- “工作区依赖”提示词骨架已经存在，但默认关闭：`desktop-app/src/main/developerInstructions/codexDesktopInstructionCatalog.ts:50-55`；composer 已支持按 capability/tool names 决定是否注入：`composeCodexDesktopInstructions.ts:17-22,43-99`。
- 当前 renderer 只有 `load_workspace_dependencies` 展示文案，没有工具实现：`desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:378-397`。
- 插件中心已经封装 `plugin/list`、`plugin/installed`、`plugin/install` 等 RPC，可复用于内部安装协调：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts:283-365,544-557`、`desktop-app/src/main/pluginCenter/PluginCenterService.ts:1011-1037`。
- UI 已经隐藏内部 `codex-app-tools`，MCP 管理页也排除 `codex_app`：`desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts:621-637`、`desktop-app/src/main/pluginCenter/PluginCenterService.ts:2591-2606`。
- packaged 配置目前只 unpack `resources/**`，没有把 bundled marketplace 放到 `process.resourcesPath/plugins`：`desktop-app/electron-builder.yml:5-20`。
- 应用启动和退出已有集中接线点：`desktop-app/src/main/index.ts:164-297,562-583,1050-1067`。

### 3.3 差距判断

这不是“少装一个 Presentations 插件”，而是以下连续能力都未接入：

```text
客户端资源中的 codex-app-tools
  → 内部 bundled plugin 发现/安装
  → codex_app stdio MCP 配置
  → app-server thread/start
  → server.mjs
  → Native Pipe
  → 宿主 tools/list / tools/call / tools/cancel
  → load_workspace_dependencies
  → Primary Runtime 真实路径
  → 能力提示词
  → Presentations skill + @oai/artifact-tool
  → .pptx
```

当前仓库只具备这条链中的 provider 配置透传、插件中心 RPC 和提示词开关骨架。

## 4. 目标架构

### 4.1 宿主能力运行时

新增 `DesktopHostCapabilityRuntime`，由 Electron main 唯一持有：

```text
DesktopHostCapabilityRuntime
  ├─ BundledPluginManager
  ├─ PrimaryRuntimeService
  ├─ DynamicAppToolRegistry
  │    └─ load_workspace_dependencies
  ├─ CodexAppToolsNativePipeServer
  ├─ CodexAppToolsMcpService
  └─ DesktopCapabilityService
```

职责边界：

- `DynamicAppToolRegistry` 只管理工具描述、namespace、handler、主机限制和 feature 条件。
- `CodexAppToolsNativePipeServer` 只负责本地传输、schema、并发、取消、安全和生命周期，不含业务工具逻辑。
- `CodexAppToolsMcpService` 只负责定位已固定/已安装 bundle、选择 Node、生成 `mcpServers.codex_app` 配置和健康检查。
- `PrimaryRuntimeService` 只负责依赖 Runtime，不知道聊天 UI 或 MCP 协议。
- `DesktopCapabilityService` 汇总“工具已注册、Pipe 已监听、MCP 可启动、Runtime feature 是否启用”等事实，给提示词和诊断使用。
- `CodexChatRuntimeService` 只消费能力快照和 MCP 配置，不复制上述实现。

### 4.2 启动顺序

把 `desktop-app/src/main/index.ts:562-583` 的启动段改为可等待的 bootstrap：

1. 解析开发/packaged 资源路径和 Runtime 配置。
2. 校验 `codex-app-tools` bundle lock；失败时记录降级原因。
3. 创建 Primary Runtime service，并执行快速本地诊断；不得在启动主线程上等待远程下载。
4. 注册 `load_workspace_dependencies` 等宿主工具。
5. 启动 Native Pipe，取得随机路径。
6. 生成 `codex_app` MCP 配置，其中显式设置 `CODEX_APP_TOOLS_PIPE_PATH`、`CODEX_MCP_NODE_PATH`、`CODEX_ELECTRON_RESOURCES_PATH` 和长工具超时。
7. 创建 app-server shared connection、catalog client 和聊天 runtime。
8. 在后台执行 bundled plugin reconcile；状态变化后刷新 capability snapshot。新 thread 使用新快照，运行中的 thread 不热换 MCP。
9. 应用退出时先停止新工具调用，再取消 pending calls、关闭 MCP 连接/聊天、关闭 Pipe、删除 socket。

如果步骤 2-6 失败，普通聊天仍可启动，但 `codex_app` 和工作区依赖提示词必须同时消失，诊断中给出单一明确原因。

### 4.3 MCP 注入方式

扩展 `CodexAspProviderSettingsInput`：

```ts
type CodexAspProviderSettingsInput = {
  // existing fields...
  mcpServers?: Record<string, McpServerConfig>;
};
```

并让 `createCodexAspProviderSettings()` 把它交给 provider。provider 的 `McpServerConfig` 需要补齐 app-server 已支持而当前类型缺少的内部字段：`enabled`、`required`、`startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools`、`disabled_tools`、`supports_parallel_tool_calls`。字段名保持 app-server config 的 snake_case；协议依据是 `codex/codex-rs/config/src/mcp_types.rs:155-205,236-302`，但不修改该 Rust 代码。

`codex_app` 的配置由 main 构建，renderer 不能覆盖：

- `command`：macOS/Linux 使用插件 launcher；Windows 使用 `.cmd` 或受控 Node 直接启动 `server.mjs`。
- `args`：绝对 `server.mjs` 路径。
- `cwd`：已校验的插件根。
- `env`：仅注入运行所需路径和 Pipe 路径；不复制整个 `process.env`。
- `startup_timeout_sec: 10`、`tool_timeout_sec: 3600`、`required: false`。
- `enabled_tools` 初期只允许 `load_workspace_dependencies`；通用能力扩展后由 registry/descriptor 生成，而不是接受用户输入。

### 4.4 Native Pipe 协议

新建 `desktop-app/src/main/appTools/`：

- `appToolsProtocol.ts`：Zod schema 和类型。
- `nativePipeFrames.ts`：4-byte LE frame 编解码和 8MiB 限制。
- `CodexAppToolsNativePipeServer.ts`：socket/Named Pipe 服务、client-id request id 重写、定向响应和清理。
- `DynamicAppToolRegistry.ts`：namespace allowlist、名称唯一性、工具列举与调用。
- `loadWorkspaceDependenciesTool.ts`：实际工具描述和 handler。
- `DesktopHostCapabilityRuntime.ts`：启动/停止编排。

协议规则：

- 只接受 `tools/list`、`tools/call`、`tools/cancel`。
- `tools/call` 必须有非空 `threadId`、`turnId`、`callId`、tool、namespace 和对象 arguments。
- host 只接受 `local`；远程 host 返回明确不支持。
- registry 只暴露允许的 namespace，启动时拒绝同名工具，避免 `server.mjs` 去掉 namespace 后发生覆盖。
- pending call 以“socket client + JSON-RPC id”隔离；一个客户端不能取消另一个客户端的请求。
- turn 已结束、thread 不属于当前本地 runtime、call 重复或过期时拒绝执行。
- abort 必须传到业务 handler；业务完成后删除 pending state。
- 非 Windows socket 放在 mode `0700` 的应用私有临时目录，socket mode `0600`，路径随机且退出删除。
- hardened macOS 构建增加一个窄 N-API peer-authorizer，只接收 socket fd 并返回同 uid/签名判断；开发环境可按显式开关启用。Windows 在 Named Pipe 上使用当前用户 ACL。若 native peer authorization 尚未完成，内部验证可继续，但不得进入公开发布门禁。

### 4.5 Primary Runtime

新建 `desktop-app/src/main/primaryRuntime/`：

- `primaryRuntimeTypes.ts`：release manifest、runtime manifest、diagnostic、progress 和状态机。
- `PrimaryRuntimeLocator.ts`：开发 override、app-owned cache、packaged bootstrap runtime 的有序定位。
- `PrimaryRuntimeDiagnostics.ts`：解析 `runtime.json`，校验平台/架构、文件存在性、可执行权限和关键包。
- `PrimaryRuntimeInstaller.ts`：下载、摘要、解压、原子切换、取消、回滚和清理。
- `PrimaryRuntimeReleaseProvider.ts`：从 main 可信配置取得平台 release descriptor。
- `PrimaryRuntimeService.ts`：对外提供 `diagnoseDependencies`、`loadDependencies`、`install`、`repair`、`cancelInstall`、`getUpdateStatus`、`runUpdateNow`、`dispose`。
- `workspaceDependencyInstructions.ts`：生成稳定、可测试的路径说明。

可信路径顺序：

1. 仅开发/测试允许的 `DASCOWORK_PRIMARY_RUNTIME_ROOT` 绝对路径。
2. 应用管理的 cache root。
3. 若未来决定随应用携带最小 Runtime，则使用 `process.resourcesPath` 下的只读 root。

禁止把 `/Applications/ChatGPT.app`、另一产品的 cache 或系统全局 Node 当成正式 fallback。当前机器已经存在可用 Runtime，可用于里程碑 A 的开发验证，但路径必须通过显式环境变量传入。

诊断至少验证：

- `runtime.json.bundleFormatVersion`、`bundleVersion`、target platform/arch。
- Node executable、node_modules、Python executable/libraries、override/fallback bin directories。
- `@oai/artifact-tool` 可解析且版本与 manifest 一致。
- Native dependencies 声明存在；Presentations 验收所需的 LibreOffice/Poppler 可执行。
- 所有返回路径都在已选择 Runtime root 内，经过 `realpath` 后仍未逃逸。

安装规则：

- release descriptor 包含 platform、arch、bundle version、archive format、size、SHA256 和允许的 HTTPS provider 列表。
- 下载写入 app cache 的临时文件，支持 AbortSignal；完成前不触碰当前 Runtime。
- 校验 size 和 SHA256 后再解压；每个 archive entry 做目标目录约束，拒绝绝对路径、`..`、symlink/hardlink 逃逸。
- 解压到版本化 staging root，完成全量 diagnostics 后原子切换 `active-runtime.json`；旧版本保留到新版本健康检查通过。
- 崩溃恢复会清理过期 staging，但不删除最后一个健康版本。
- 同一时间只允许一个 install/repair/update；重复请求共享同一 promise，取消可重复调用。
- 更新轮询有抖动、退避和显式关闭；不阻塞应用启动。

`load_workspace_dependencies` 成功时返回参考项目同等信息：bundle version、Node.js executable、Node.js packages、Python executable、Python packages、override binaries、fallback binaries，以及可选 Git/pnpm。失败时返回稳定的“禁用 / 未安装 / 损坏 / 当前平台不支持”之一，不泄露下载 URL、token 或内部堆栈。

### 4.6 Bundled Plugin 自动安装与内部管理

新建 `desktop-app/src/main/bundledPlugins/`：

- `bundledPluginTypes.ts`
- `bundledPluginCatalog.ts`
- `BundledPluginManager.ts`
- `bundledPluginPaths.ts`
- `bundleIntegrity.ts`

描述符至少包含：

```ts
type BundledPluginDescriptor = {
  marketplaceName: string;
  name: string;
  version: string;
  sourceRoot: string;
  installWhenMissing: boolean;
  requiredForCapabilities?: string[];
  hiddenFromUserManagement?: boolean;
  featureEnabled: () => boolean | Promise<boolean>;
};
```

初始 descriptor：

- `openai-bundled/codex-app-tools`：`installWhenMissing=true`、内部隐藏、始终参与本地能力检测。
- Primary Runtime 安装完成后，从 `runtime.json.bundledPlugins` 发现 `openai-primary-runtime` marketplace；Presentations 等具体插件仍通过同一 descriptor/reconcile 流程安装，不写专用复制代码。

reconcile 行为：

1. 校验 marketplace manifest、plugin manifest 和 bundle lock。
2. 调用现有 catalog client 的 `plugin/installed` 判断版本/启用状态。
3. 缺失时用本地 `marketplacePath + pluginName` 调 `plugin/install`；已安装但禁用时按内部策略恢复启用。
4. 安装成功后重新读取确认，不以 RPC 无异常代替最终状态。
5. 安装失败时保留旧版本、清除“正在安装”，记录可诊断原因，不无限重试。
6. 内部插件继续从普通插件列表和 MCP 设置页隐藏，用户不能卸载 `codex-app-tools`；开发诊断页/日志可查看版本、来源 SHA、Pipe 和 MCP 健康状态。
7. reconcile 完成后失效插件中心、skills 和 capability cache；已有 thread 不热换技能，新 thread 获得新目录。

### 4.7 能力确认与提示词注入

新增 `DesktopCapabilityService`，返回结构化快照，而不是散落的布尔量：

```ts
type DesktopCapabilitySnapshot = {
  hostId: "local";
  tools: string[];
  mcpServers: { codex_app?: "ready" | "degraded" | "unavailable" };
  workspaceDependencies: {
    featureEnabled: boolean;
    toolAvailable: boolean;
    runtimeState: "ready" | "missing" | "broken" | "unsupported";
  };
};
```

在 `desktop-app/src/main/codexChatRuntimeService.ts:760-763` 调用提示词 composer 时传入：

- `availableToolNames = snapshot.tools`
- `capabilities.workspaceDependencies = featureEnabled && toolAvailable`

提示词只能说明“先调用工具获取路径”，不能直接嵌入 Runtime 路径。真正路径每次由工具调用返回，避免升级后旧 thread 继续使用过期路径。当前 `composeCodexDesktopInstructions.ts:43-99` 已具备按能力选择 section 的机制，只需接入真实 snapshot 并扩充测试。

## 5. 分阶段实施步骤

### Phase 0：固定 bundle 和资源打包基线

目标：完成用户要求的“先把现有 `codex-app-tools` 放到客户端”，但不把整棵 `external` 搬进来。

1. 新增资源树：

   - `desktop-app/resources/bundled-plugins/openai-bundled/.agents/plugins/marketplace.json`
   - `desktop-app/resources/bundled-plugins/openai-bundled/.bundle-id`
   - `desktop-app/resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/**`
   - `desktop-app/resources/bundled-plugins/openai-bundled/bundle-lock.json`

2. `marketplace.json` 只列 `codex-app-tools`；不要复制 Browser、Chrome、Sites、Visualize 等条目。
3. `bundle-lock.json` 记录参考版本 `26.818.21641`、原始相对路径、5 个文件的 SHA256、插件版本和复制日期；不要修改 `server.mjs`、`.mcp.json` 或 launcher 内容。
4. 新增 `desktop-app/scripts/sync-codex-app-tools-bundle.mjs`，只允许从显式 `--source` 读取，复制前后都校验 allowlist 和 SHA；出现多余文件、缺文件或摘要变化即失败。
5. 新增 `desktop-app/scripts/verify-bundled-plugins.mjs` 和 npm script，CI/build 前验证 lock。
6. 修改 `desktop-app/electron-builder.yml`：从普通 asar files 排除 `resources/bundled-plugins/**`，再用 `extraResources` 放到 packaged 的 `process.resourcesPath/plugins/**`；确保 `.sh` 可执行位和 `.cmd` 均保留。
7. 添加 `ORIGIN.md`/许可证说明到 marketplace 根，而不是改动插件本体；公开发布工作流在法律授权未确认时失败关闭。

Phase 0 验收：开发目录和 unpacked app 中的 5 个文件 SHA 与参考一致；packaged 路径没有 `reference-projects` 依赖；整个 `external` 没有进入产物。

### Phase 1：Native Pipe 与通用工具注册表

1. 在 `desktop-app/src/main/appTools/` 完成协议、frame、server、registry 和 runtime 编排。
2. 先注册一个测试 echo/abort 工具，验证 list、call、错误和 cancel，再注册真实 `load_workspace_dependencies`。
3. 增加 stale socket 清理、重复启动保护、单例生命周期和退出清理。
4. 增加 namespace/tool allowlist、thread/turn/call 校验和并发隔离。
5. 为 macOS peer authorization 建立独立 native build lane；在未完成时通过 release feature gate 阻止公开发版。

Phase 1 验收：一个真实 `server.mjs` 进程可经 stdio 收到 MCP `tools/list`，再经 Pipe 获得宿主工具；并发请求结果不串线，取消请求会让对应 handler 的 AbortSignal 变为 aborted。

### Phase 2：provider/app-server/MCP 接线

1. 扩展 `desktop-app/src/main/codexAspProvider.ts` 输入和设置，注入 main-owned `mcpServers`。
2. 扩展 provider `McpServerConfig` 类型并补充 `thread-client`/model 两条 thread-start 路径测试，确保 stdio env、cwd、超时和工具 allowlist 原样进入 `config.mcp_servers.codex_app`。
3. `CodexChatRuntimeServiceOptions` 增加只读 MCP config 和 capability snapshot provider；构造 provider 时使用同一快照。
4. 在 `index.ts` 中先启动 host capability runtime，再构造聊天 runtime；Pipe 未 ready 时不注入 MCP。
5. 使用 `mcpServerStatus/list` 做健康确认：`codex_app` ready 且含预期工具时才标记 MCP ready。

Phase 2 验收：app-server 记录的 `thread/start` 包含完整 `codex_app` 配置；MCP 子进程拿到 Pipe 路径；关闭 Pipe 或改坏 SHA 时新会话不会收到虚假的工具提示。

### Phase 3：`load_workspace_dependencies` 真实实现，完成里程碑 A

1. 用一个小型测试 Runtime fixture 实现 diagnostics 和 instruction formatting。
2. 支持开发环境显式指向当前机器已有 Runtime；只做读取和诊断，不复制、不修改该目录。
3. handler 只接受 `{}`，只支持 `hostId=local`，并返回 `DynamicToolCallResponse` 的 text content。
4. 通过真实 `server.mjs` 执行一次 MCP call，验证返回中包含 fixture/开发 Runtime 的绝对 Node、node_modules 和 bin 路径。
5. 把 Pipe/MCP/tool 调用写入结构化安全日志：只记录版本、状态、耗时、tool 名和匿名 call id，不记录用户 prompt、完整 arguments 或敏感 env。

里程碑 A 完成判定：无需 Runtime 下载、无需 Presentations，就能从 MCP 客户端穿过完整桥接链得到真实依赖路径；删除 Pipe env、传远程 host、传非空参数、传超大 frame 都得到预期错误。

### Phase 4：Primary Runtime 管理服务

1. 在 `desktop-app/src/main/runtimeConfig.ts` 增加 main-only Runtime 配置：feature flag、开发 root、release manifest endpoint/内嵌 descriptor、轮询间隔和发布 channel。
2. 完成 locator、manifest parser、diagnostics 和状态机。
3. 完成下载、摘要验证、安全解压、staging、原子激活、回滚和取消。
4. 完成 repair/reset、更新检查、退避轮询和应用关闭 cleanup。
5. 用小 fixture archive 覆盖成功、SHA 错误、截断下载、路径穿越、平台不匹配、安装中崩溃和回滚。
6. 若仓库现有依赖不能安全、跨平台解压目标格式，先做独立依赖评审；不得用 shell 拼接调用任意归档工具，也不得为了省依赖写未经充分测试的通用解压器。

Phase 4 验收：从可信 fixture release 开始可完整安装并激活；旧 Runtime 在新版本诊断通过前始终可用；重启后能恢复 active version；无网络时使用最后健康版本。

### Phase 5：Bundled Plugin 自动安装和内部管理

1. 实现 descriptor catalog 和 `BundledPluginManager.reconcile()`。
2. 复用现有 `CodexContextCatalogClient` 和 app-server `plugin/install`，不要在 main 手写 Codex plugin cache 格式。
3. 自动安装/恢复 `codex-app-tools`；安装后验证 `plugin/installed` 和 `mcpServerStatus/list`。
4. Primary Runtime ready 后读取其 `runtime.json.bundledPlugins`，同步 `openai-primary-runtime` marketplace 并安装声明为自动安装的插件。
5. 为 Presentations、Documents、PDF、Spreadsheets 建数据驱动 descriptor；后续插件只需资源/descriptor，不改 installer。
6. 保留当前内部隐藏行为，并增加 main-only diagnostics；不要让用户从 UI 卸载宿主桥。

Phase 5 验收：清空测试 `CODEX_HOME` 后启动应用，`codex-app-tools` 自动出现为已安装/启用但不在普通 UI 展示；Runtime 安装后 Presentations skill 能通过 `skills/list` 被发现；第二次启动不重复安装。

### Phase 6：能力快照、提示词和降级行为

1. 接入 `DesktopCapabilityService`，让提示词 composer 获取真实 tool names/capabilities。
2. 修改 `composeCodexDesktopInstructions.test.ts` 和 `desktop-context.e2e.ts`：默认失败关闭；只有真实 capability snapshot 才出现 `load_workspace_dependencies`。
3. MCP 健康、Runtime 状态、bundled plugin 状态变化时失效快照；新会话读取新快照。
4. 错误信息区分 bundle 损坏、Pipe 启动失败、MCP 启动失败、Runtime 缺失/损坏、feature disabled 和 unsupported platform。
5. 增加开发诊断输出/页面，展示版本和状态，不展示 Pipe 路径、下载凭据或用户目录全路径。

Phase 6 验收：能力 ready 时新 thread 的 developer instructions 有且仅有一个 Workspace Dependencies section；任一前置条件失效时 section 消失或工具返回精确降级原因，不出现“提示存在但工具不可调用”的状态。

里程碑 B 完成判定：Runtime 安装/更新、两个 marketplace 的内部管理、通用工具注册、MCP 健康和能力提示词已经形成闭环；后续新增宿主工具或 Runtime 插件只需增加描述符与 handler。

### Phase 7：Presentations 真实闭环，完成里程碑 C

1. 准备固定 HTML 输入和确定性输出目录；HTML 内容只使用本地文本/素材，避免把图片搜索、外部 connector 作为本验收的额外变量。
2. 确认新 thread 的 skills 中包含 Presentations，且其 skill 文件来自当前 active Primary Runtime 对应版本。
3. 通过真实聊天链发送“根据 HTML 内容生成一份 AI Agent 安全市场简单分析 PPT”。
4. 记录并断言 `load_workspace_dependencies` 经 `codex_app` 被调用一次以上；返回路径必须属于 active Runtime。
5. 从 app-server command item 证据断言 authoring 使用返回的 `RUNTIME_NODE` 和 `@oai/artifact-tool`，未使用 `python-pptx`、手写 OOXML 或系统全局 Node modules。
6. 断言 Presentations skill 的 `mark_artifact_operation_started.mjs` 在首次写操作前成功执行一次。
7. 验证 `.pptx` 为有效 OOXML zip，含 `[Content_Types].xml`、`ppt/presentation.xml` 和至少一页 slide。
8. 用 Runtime 自带的 render/slide test 工具生成 PNG 并检查无结构错误、无文本溢出；至少人工查看一次 montage，保存测试证据，不把临时文件当用户交付物。
9. 如当前 Artifact/PPTX preview 工作已合入，增加生成后自动打开 Artifact tab 的联动 smoke；否则只验证文件卡/链接可打开，预览闭环由现有独立计划继续。
10. 增加一个第二工具或第二内部插件 fixture，证明平台不是为 Presentations 特写的单用途代码。

里程碑 C 完成判定：最终 `.pptx` 真实生成、可打开、可渲染、无溢出；会话事件能证明它走了 `load_workspace_dependencies + @oai/artifact-tool` 标准链，而不是 fallback。

## 6. 可测试验收标准

### 6.1 Bundle 与打包

- **AC-01**：`verify-bundled-plugins` 对当前 5 个文件通过；修改 `server.mjs` 任意 1 byte 后失败。
- **AC-02**：`build:unpack` 后 `process.resourcesPath/plugins/openai-bundled/plugins/codex-app-tools/server.mjs` 存在，SHA 为 `2a5a64...a222`，launcher 可执行。
- **AC-03**：packaged 产物不包含 `reference-projects/` 或除 `codex-app-tools` 以外的参考 bundled plugins。

### 6.2 Pipe 与 MCP

- **AC-04**：fragmented frame、coalesced frames、零长度、>8MiB、非法 JSON、非法 method 都有单元测试。
- **AC-05**：两个 MCP clients 使用相同 request id 时结果仍定向到原客户端；一个 client 的 cancel 不影响另一个。
- **AC-06**：真实 `server.mjs` 能完成 MCP initialize/list/call/shutdown；缺少 `CODEX_APP_TOOLS_PIPE_PATH` 时返回明确连接错误。
- **AC-07**：thread/turn/call metadata 从 app-server/MCP 传到宿主 handler；缺 thread metadata 时 server 拒绝调用。

### 6.3 Runtime 与插件

- **AC-08**：完整 fixture Runtime 返回 installed=true 和全部绝对路径；缺 `@oai/artifact-tool`、错误 arch、逃逸 symlink 或不可执行 Node 时 installed=false 且 problems 非空。
- **AC-09**：错误 SHA、路径穿越 archive、下载取消不会替换 active Runtime，也不会残留可被选中的 staging。
- **AC-10**：Runtime 升级后新 thread 获得新 bundle version；旧版本直到新版本 health check 通过才清理。
- **AC-11**：空 `CODEX_HOME` 自动安装 `codex-app-tools`，二次启动幂等；内部插件不能从普通 UI 卸载。
- **AC-12**：Runtime marketplace 同步后 `skills/list` 能发现 Presentations；新增第二 descriptor 无需改 Pipe、provider 或 installer。

### 6.4 提示词与 Presentations

- **AC-13**：`workspaceDependencies` feature 或 `codex_app` tool 任一个不可用时，developer instructions 不包含“call `load_workspace_dependencies`”。
- **AC-14**：能力可用时该 section 只出现一次，retry/resume 不重复注入。
- **AC-15**：真实聊天调用记录中出现 `codex_app/load_workspace_dependencies`，结果的三个 Presentations 关键路径都位于 active Runtime。
- **AC-16**：生成命令使用 Runtime Node 和 `@oai/artifact-tool`；测试主动拒绝 `python-pptx`、手写 zip/OOXML 和全局 package fallback。
- **AC-17**：最终 PPTX 结构校验、渲染和 overflow test 全部通过，最终文件位于宿主允许的输出目录。

### 6.5 生命周期与安全

- **AC-18**：应用退出后 Pipe/Named Pipe 不再接受连接，socket 文件清理，pending handler 全部 aborted。
- **AC-19**：renderer 无 API 可以提交任意 MCP command/env、Runtime URL、安装 root 或 Native Pipe path。
- **AC-20**：公开 release job 在 peer authorization 未启用、bundle lock 不匹配或 proprietary 分发授权标记缺失时失败关闭。

## 7. 测试与验证矩阵

| 层级              | 新增/修改测试                                                                                               | 证明内容                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Bundle script     | `desktop-app/scripts/tests/verify-bundled-plugins.node-test.mjs`                                            | allowlist、SHA、marketplace manifest、路径和 packaged layout。                                            |
| Pipe unit         | `desktop-app/src/main/appTools/*.test.ts`                                                                   | frame、schema、client 隔离、cancel、allowlist、shutdown。                                                 |
| Pipe integration  | `desktop-app/tests/integration/codex-app-tools-mcp.test.ts`                                                 | 真实 `server.mjs` stdio MCP ↔ Native Pipe ↔ fake/real tool。                                              |
| Runtime unit      | `desktop-app/src/main/primaryRuntime/*.test.ts`                                                             | manifest、诊断、路径安全、状态机、指令格式。                                                              |
| Runtime installer | `desktop-app/tests/integration/primary-runtime-installer.test.ts`                                           | fixture archive 下载、SHA、安全解压、原子激活、回滚、取消。                                               |
| Bundled plugins   | `desktop-app/src/main/bundledPlugins/BundledPluginManager.test.ts`                                          | installWhenMissing、幂等、升级、失败恢复、内部隐藏。                                                      |
| Provider          | `desktop-app/src/main/codexAspProvider.test.ts`、`vendors/.../tests/provider.test.ts`、`thread-client` 覆盖 | `mcpServers` 和超时/env 完整进入 thread/start。                                                           |
| Runtime service   | `desktop-app/src/main/codexChatRuntimeService.test.ts`                                                      | capability snapshot、提示词、retry/resume、新旧 thread 行为。                                             |
| Electron E2E      | `desktop-app/tests/e2e/app-tools-host.e2e.ts`                                                               | renderer → main → provider → app-server fixture 的 MCP 配置与 UI render unit。                            |
| Packaged smoke    | `desktop-app/scripts/run-packaged-app-tools-smoke.mjs`                                                      | extraResources、launcher、Node、Pipe 和退出清理。                                                         |
| Live LLM smoke    | `desktop-app/scripts/run-presentations-smoke.mjs`                                                           | 真实模型选择技能、调用 load tool、使用 artifact-tool、生成 PPTX。默认 opt-in，不把模型随机性放入普通 CI。 |

每个阶段完成时运行最小验证；全部阶段合并前运行：

```text
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run test
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run test:unit
npm --prefix desktop-app run test:e2e -- tests/e2e/app-tools-host.e2e.ts --reporter=line
npm --prefix desktop-app run build:unpack
npm --prefix desktop-app run test:e2e:packaged
```

Live Presentations smoke 单独执行，并保存 tool-call、command item、PPTX 结构和渲染证据；不能用普通单元测试的通过替代该项。

## 8. 文件改造清单

### 8.1 新增

- `desktop-app/resources/bundled-plugins/openai-bundled/**`
- `desktop-app/scripts/sync-codex-app-tools-bundle.mjs`
- `desktop-app/scripts/verify-bundled-plugins.mjs`
- `desktop-app/src/main/appTools/**`
- `desktop-app/src/main/primaryRuntime/**`
- `desktop-app/src/main/bundledPlugins/**`
- `desktop-app/src/main/capabilities/DesktopCapabilityService.ts`
- 对应 unit/integration/E2E/packaged smoke 文件

### 8.2 修改

- `desktop-app/electron-builder.yml`
- `desktop-app/package.json`
- `desktop-app/src/main/index.ts`
- `desktop-app/src/main/runtimeConfig.ts`
- `desktop-app/src/main/codexAspProvider.ts`
- `desktop-app/src/main/codexChatRuntimeService.ts`
- `desktop-app/src/main/developerInstructions/composeCodexDesktopInstructions.ts` 及测试
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/provider-settings.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/thread-client.ts` 仅在类型/序列化需要时修改；现有透传逻辑优先复用
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts` 仅接入 cache invalidation/内部诊断；不把自动安装逻辑塞进 UI service

### 8.3 禁止修改

- `codex/codex-rs/app-server/**`
- `codex/codex-rs/core/**`
- renderer 的 Node/Electron 安全边界
- 用户当前工作树中与 Artifact/PPTX 预览有关、但不属于本计划的实现，除非联动测试明确需要并先协调所有权

## 9. 风险与缓解

| 风险                                         | 影响                                     | 缓解                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `server.mjs` 为 Proprietary                  | 对外发布可能无权分发                     | 内部验证先 SHA 固定；release job 加授权门禁；保留 clean-room bridge 替换路线。                                                            |
| Pipe 只有随机路径/0600，不等于 peer 身份校验 | 同用户恶意进程可能抢连                   | macOS N-API peer authorizer、Windows Pipe ACL、私有目录、client 隔离；未完成不公开发布。                                                  |
| Primary Runtime 体积大、下载易失败           | 首次使用慢、磁盘占用大                   | 后台下载、进度、断点/取消、SHA、原子激活、保留旧健康版、磁盘预检。                                                                        |
| Runtime release feed 尚未由本项目定义        | 正式自动安装没有可信来源                 | 把 release provider 设计成 main-only 注入契约；先用 fixture/显式开发 root；正式发布前接入获授权的签名 manifest。                          |
| 插件自动安装与 MCP 显式配置重复              | 可能出现两个 `codex_app`                 | main-owned `mcpServers.codex_app` 为唯一运行配置；plugin install 负责目录/skill 状态，静态 plugin MCP 保持关闭；测试断言只有一个 server。 |
| 当前 provider MCP 类型字段不完整             | 3600 秒工具可能被 120 秒默认超时提前终止 | 扩展内部 config 字段并断言 thread/start wire payload；区分 provider 动态工具 timeout 与 MCP server tool timeout。                         |
| 安装后已有 thread 看不到新技能               | 用户认为安装无效                         | 状态变化明确提示“新任务生效”；新 thread 重新获取 skills/MCP；不冒险热改运行中的 thread。                                                  |
| Live LLM E2E 有随机性                        | CI 偶发失败                              | 核心 Pipe/MCP/Runtime 用确定性测试；live smoke 独立、可重试且必须保存可审计事件。                                                         |
| Presentations 仍可能自行 fallback            | 生成了文件但没验证标准链                 | E2E 同时断言 load tool、Runtime Node、artifact-tool 命令和禁止项，不能只看 `.pptx` 存在。                                                 |
| 与当前 Artifact/PPTX 预览工作树冲突          | 容易误改用户已有工作                     | 本计划以生成链为主；只在最后一项加联动 smoke，实施前基于当前 diff 协调文件所有权。                                                        |

## 10. 建议实施顺序与提交边界

建议保持小而可回滚的提交：

1. `chore: pin codex-app-tools bundled artifact`
2. `feat: add dynamic app tools native pipe and registry`
3. `feat: inject codex_app mcp through codex asp provider`
4. `feat: implement load_workspace_dependencies diagnostics`
5. `feat: manage primary runtime lifecycle`
6. `feat: reconcile bundled and primary runtime plugins`
7. `feat: derive desktop instructions from host capabilities`
8. `test: prove presentations artifact-tool generation end to end`

每个提交都应有对应测试，且不得把 976KB bundle 与大量业务源码混在同一个不可审查提交中。

## 11. 完成定义

只有同时满足以下条件，才算“通用能力建设完成”：

- 真实 `codex-app-tools` bundle 在开发和 packaged 环境都能由 app-server 作为 MCP 启动。
- Native Pipe 的 list/call/cancel、隔离、安全、退出清理全部通过。
- `load_workspace_dependencies` 返回当前健康 Primary Runtime 的真实路径，并在缺失/损坏时正确失败关闭。
- Primary Runtime 可由可信 release 完成安装、诊断、修复、更新、取消和回滚。
- bundled plugin reconcile 是数据驱动且幂等，`codex-app-tools` 与 Runtime marketplace 都由它管理。
- 提示词只声明真实能力，新 thread 能发现 Presentations skill。
- 真实会话使用 `load_workspace_dependencies + @oai/artifact-tool` 生成并验证 PPTX。
- 再增加一个宿主工具或 bundled plugin fixture 时，不需要改 Pipe、provider 或 installer 核心代码。
- 发布所需的 bundle 授权、peer authorization 和 Runtime release feed 三项门禁均有明确结论；否则只能标记为“内部工程验证完成”，不能标记为“可公开分发”。
