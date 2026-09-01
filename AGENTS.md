# Agent Rules

## 沟通规则

1. **不要假设用户清楚自己想要什么。** 当动机或目标不清晰时，停下来讨论，而不是猜测着往前冲。做错了再改的成本远高于多问一句。
2. **目标清晰但路径不是最短的，直接说并建议更好的办法。** 用户可能因为惯性选择了次优方案，AI 有责任指出更短的路径——但最终决定权在用户。
3. 使用非程序员黑话回答

## 项目全局架构

本仓库是在 Electron 桌面端里嵌入 Codex app server 的协作应用。大模型工作时先按层定位问题：UI 和本地桌面能力在 `desktop-app/`，LLM 执行基座在 `codex/codex-rs/app-server`，AI SDK 到 app-server 的协议适配在 `desktop-app/vendors/ai-sdk-provider-codex-asp/`。

当前是以codex app server作为基础开发, 禁止修改codex app server的代码

### 相关接口文档

- [AI SDK Provider Codex ASP API 说明](docs/ai-sdk-provider-codex-asp-api.md)
- [Codex App Server 官方说明整理](docs/codex-app-server-official-notes.md)

### 分层职责

- `desktop-app/src/renderer/`：React、assistant-ui、AI SDK UI runtime；负责聊天界面、模型选择、审批面板，只能通过 preload 暴露的 API 访问桌面能力。
- `desktop-app/src/preload/`：`contextBridge` 安全桥；暴露 `window.desktopCodex` 和 `window.desktopCodexChat`，用 `ipcRenderer.invoke` 与 `MessageChannel` 连接 renderer 和 main。
- `desktop-app/src/main/`：Electron main process；负责窗口、IPC payload 校验、外链限制、runtime 生命周期、模型目录、审批转发和 app-server 启动配置。
- `desktop-app/vendors/ai-sdk-provider-codex-asp/`：AI SDK provider fork；负责把 `streamText()`、`provider.chat(modelId)`、`codexCallOptions()` 映射成 Codex App Server Protocol。
- `codex/codex-rs/app-server/`：Codex 执行基座；负责 thread/turn 生命周期、cwd、sandbox、审批、MCP、工具调用、elicitation、模型 provider 配置和最终 LLM 请求。
- admin backend：只提供模型目录、用户可见模型选择和 provider 凭据等配置数据；不是桌面聊天推理链路的执行基座。

### 核心数据流

- 启动与模型列表：Renderer 调 `desktopCodex.listModels()` -> Preload `codex:list-models` -> Main `CodexChatRuntimeService.listModels()` -> provider/app-server 或 admin backend -> 归一化为 `CodexModelList` 返回 UI。
- 聊天流：assistant-ui -> `ElectronIpcChatTransport` -> Preload `desktopCodexChat.startChatStream()` -> `codex-chat:start` + `MessagePort` -> Main Zod 校验 -> `CodexChatRuntimeService.startChatStream()` -> AI SDK `streamText()` -> `@janole/ai-sdk-provider-codex-asp` -> stdio JSON-RPC -> `codex-app-server` -> custom model provider。响应按相反方向以 `chunk`、`finish`、`aborted`、`error` 回到 renderer。
- 审批流：app-server 发出 command/file/tool/mcp 等 server request -> provider -> `CodexApprovalBroker` -> Main `webContents.send('codex:approval-request')` -> Renderer 审批面板 -> `codex:respond-approval` -> broker resolve -> provider -> app-server。
- app-server 启动：默认从应用进程的 `PATH` 执行 `codex app-server --listen stdio://`；`CODEX_APP_SERVER_BIN` 只用于测试替身。

### 架构边界

- 禁止在桌面聊天推理路径中绕过 Codex app server 直接调用 OpenAI-compatible API、Responses API、第三方 SDK、`fetch` 模型接口或新建独立 LLM client。
- 禁止把 admin backend 返回的 API key、provider headers 或完整模型配置暴露给 renderer；敏感信息只能在 main process、provider 和 app-server 子进程边界内流动。
- Provider fork 拥有 AI SDK 与 Codex App Server Protocol 的映射逻辑；desktop main 不应复制 provider 内部协议实现。
- Renderer 不能直接使用 Node/Electron 能力；新增能力必须经过 preload 白名单、shared schema 和 main IPC handler。
- 涉及 thread/start、thread/resume、turn/start、approval、sandbox、cwd、MCP、tools 或 elicitation 的改动，优先确认应落在 app-server、provider fork、main process 还是 renderer。

### 排障与验证

遇到“发送无回复”“模型不可用”“custom provider 不生效”时按链路排查：Renderer 是否发出 `codex-chat:start` -> Main 是否通过 shared schema 并进入 runtime -> 模型目录是否解析到选中模型 -> provider 是否发送正确的 `thread/start`/`thread/resume`/`turn/start` -> app-server thread config 是否包含期望的 `model_provider`/`model_providers` -> app-server 是否请求 custom provider -> 事件是否映射回 AI SDK stream 并经 MessagePort 回到 renderer。

推荐验证：

- Provider 层：`npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint`、`npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck` 和相关 provider tests。
- Desktop 层：`npm --prefix desktop-app run lint`、`npm --prefix desktop-app test`。
- 聊天链路或模型供应商：`npm --prefix desktop-app run test:e2e -- --reporter=line`，并确保断言覆盖真实 renderer -> IPC -> main -> provider -> Codex app server -> custom provider 路径。

## 工具说明

assistant-ui组件可以使用assistant-ui mcp获取文档和示例信息

## 参考项目分析规则

- 只要任务涉及 `reference-projects/` 下的 Electron 解包项目，必须先加载项目技能 `.codex/skills/reference-electron-analysis/SKILL.md`，按其中的低 token 索引流程执行。
- 人工使用说明见 `docs/reference-electron-analysis.md`。
- 默认先运行完整的 `reference:chatgpt:validate`，再用 `reference:chatgpt:query` 返回不超过 8 个候选；禁止把大 bundle 或无上限的图概览直接塞进模型上下文。
- 跨文件关系才生成最多 30 个文件的语义切片，并只在切片上使用 LSP 或 code-review-graph。
- 图、索引、LSP 和反编译结果都只是定位工具。最终行为结论必须回查原参考文件并给出精确行号；新解包版本还要给出 `_analysis/raw/` 中排版前原包的行、列和 SHA256。
- 新版本统一通过 `npm --prefix desktop-app run reference:chatgpt -- --force` 解包；该命令会自动保留原包文本镜像并生成索引。
