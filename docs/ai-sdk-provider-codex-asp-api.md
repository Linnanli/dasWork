# ai-sdk-provider-codex-asp API 文档

整理日期：2026-09-04

关联文档：`codex-app-server-official-notes.md`

## 1. 定位

`@janole/ai-sdk-provider-codex-asp` 是保留给仓库外 AI SDK consumer 的兼容包。它把 AI SDK v6 / `LanguageModelV3` 的 `streamText()`、`generateText()`、tool、provider options 和 stream parts 映射到 Codex App Server Protocol 的 JSON-RPC 生命周期。

桌面生产聊天链路自 2026-09-04 起不再使用该包。它由 Main-owned
`NativeCodexRunDriver` 和 AI-free
`@dascowork/codex-app-server-client` 直接驱动 app-server；本文件的 API
说明仅用于维护兼容包及其独立测试，不能作为 desktop Main 的实现依据。

本 provider 不直接调用 OpenAI-compatible API、Responses API 或第三方 LLM SDK。真正的模型请求由 `codex-app-server` 根据 thread / turn 配置发起。

运行中追问有两个不同协议：

- Queue 在当前 turn 终止后，仍通过既有聊天链路创建新的 `turn/start`。
- Steer 在同一个活跃 `CodexSession` 上调用 `turn/steer`，必须带当前
  `expectedTurnId` 与稳定的 `clientUserMessageId`，不会创建新的 turn。

兼容 API `CodexSession.injectMessage()` 会启动新 turn，不属于 P0-01 的 Steer
实现，也不得用“中断后重发”替代 `turn/steer`。

主要源码：

- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/index.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/provider.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/model.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/provider-settings.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/client/*`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/*`

兼容包的历史集成入口：

- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/provider.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/model.ts`
- `desktop-app/vendors/codex-app-server-client/src/`

## 2. 包与导出

包名：`@janole/ai-sdk-provider-codex-asp`

当前版本：`0.4.15`

运行要求：Node.js `>=20`，peer dependency 为 `ai@^6.0.0`。

主导出：

```ts
import {
  createCodexAppServer,
  createCodexProvider,
  codexAppServer,
  codexCallOptions,
  CODEX_PROVIDER_ID,
  AppServerClient,
  StdioTransport,
  WebSocketTransport,
  PersistentTransport,
  CodexWorkerPool,
  ApprovalsDispatcher,
  DynamicToolsDispatcher,
  CodexEventMapper,
  mapCodexThreadTurnsToUiMessages,
} from "@janole/ai-sdk-provider-codex-asp";
```

说明：

- `createCodexAppServer()` 是主工厂函数。
- `createCodexProvider` 是兼容旧命名的别名。
- `codexAppServer` 是默认配置创建的单例 provider。
- `CODEX_PROVIDER_ID` 固定为 `@janole/ai-sdk-provider-codex-asp`，用于 AI SDK `providerOptions` 和 `providerMetadata`。
- `src/types.ts` 与 `src/stream.ts` 是早期脚手架残留，不是当前主路径 API。

### 2.1 恢复错误码

`CodexProviderError` 可以携带稳定的 `code`。桌面 main 仅依据该 code 决定是否尝试恢复既有 turn；错误文案仅用于脱敏后的用户展示，不能参与控制流。

```ts
import {
  CodexProviderError,
  isCodedCodexProviderError,
  type CodexProviderErrorCode,
} from "@janole/ai-sdk-provider-codex-asp";
```

当前恢复相关 code：

- `app_server_transport_closed`：app-server transport 异常关闭；在同一 thread/turn 的恢复快照存在时，main 可尝试一次 existing-turn recovery。
- `app_server_transport_terminated`：transport 被终止；恢复资格与关闭错误相同。
- `active_turn_unavailable`：恢复时 app-server 已不再拥有原 active turn；main 保留已有内容并收敛为 interrupted，绝不发起第二个 `turn/start`。

没有这些 code 的普通 `Error`，即使文案看起来像 transport 故障，也不会触发 existing-turn recovery。

## 3. Provider API

### 3.1 创建 provider

```ts
const codex = createCodexAppServer({
  defaultModel: "gpt-5.5",
  clientInfo: {
    name: "dascowork_desktop",
    title: "dasCowork Desktop",
    version: "1.0.0",
  },
  experimentalApi: true,
  transport: {
    type: "stdio",
    stdio: {
      command: "/path/to/codex-app-server",
      args: ["--listen", "stdio://"],
      cwd: "/path/to/codex/codex-rs",
      env: process.env,
    },
  },
});
```

### 3.2 Provider 对象

`createCodexAppServer()` 返回的 provider 同时是函数和对象：

```ts
const modelA = codex("gpt-5.5");
const modelB = codex.chat("gpt-5.5");
const modelC = codex.languageModel("gpt-5.5");

const models = await codex.listModels();
const thread = await codex.startThread({
  modelId: "gpt-5.5",
  system: "You are a concise assistant.",
  callOptions: {
    cwd: "/absolute/project",
    runtimeWorkspaceRoots: ["/absolute/project"],
  },
});
await codex.shutdown();
```

接口行为：

- `codex(modelId, settings?)`：返回 `CodexLanguageModel`。
- `chat(modelId, settings?)`：返回 `CodexLanguageModel`。
- `languageModel(modelId)`：返回 `CodexLanguageModel`。
- `listModels(params?)`：连接 app-server，执行 `initialize` / `initialized`，分页调用 `model/list`。
- `startThread(options?)`：连接 app-server，执行 `initialize` / `initialized` / `thread/start`，返回 `CodexStartedThread`（`{ threadId, threadPath? }`）；适合显式创建空线程或由调用方自己管理后续 resume 生命周期。首轮聊天要在用户发送后立刻拿到会话 id 时，优先使用 `codexCallOptions({ onThreadStarted })`，让 `thread/start` 和首个 `turn/start` 保持在同一个 app-server 会话内。
- `shutdown()`：关闭 provider-owned persistent pool；当 desktop 注入 host-scoped connection 时，关闭其 broker 管理的单一物理连接。
- `embeddingModel()` / `imageModel()`：显式抛 `NoSuchModelError`。

## 4. Provider 配置

主配置类型是 `CodexProviderSettings`。

### 4.1 顶层配置

```ts
type CodexProviderSettings = {
  defaultModel?: string;
  modelProvider?: string;
  customModelProviders?: Record<string, CodexModelProviderInfo>;
  mcpServers?: Record<string, McpServerConfig>;
  clientInfo?: { name: string; version: string; title?: string };
  experimentalApi?: boolean;
  transport?: {
    type?: "stdio" | "websocket";
    stdio?: StdioTransportSettings;
    websocket?: WebSocketTransportSettings;
  };
  transportFactory?: (context: TransportContext) => CodexTransport;
  defaultThreadSettings?: CodexThreadDefaults;
  defaultTurnSettings?: CodexTurnDefaults;
  compaction?: CodexCompactionSettings;
  tools?: Record<string, DynamicToolDefinition>;
  toolHandlers?: Record<string, DynamicToolHandler>;
  toolTimeoutMs?: number;
  interruptTimeoutMs?: number;
  approvals?: CodexApprovalCallbacks;
  debug?: CodexDebugSettings;
  persistent?: CodexPersistentSettings;
  emitPlanUpdates?: boolean;
  onSessionCreated?: (session: CodexSession) => void;
};
```

默认值：

- 未指定 transport 时使用 `StdioTransport`。
- stdio 默认命令是 `codex app-server --listen stdio://`。
- websocket 默认 URL 是 `ws://localhost:3000`。
- `toolTimeoutMs` 默认 `30_000`。
- `interruptTimeoutMs` 默认 `10_000`。
- `emitPlanUpdates` 默认 `true`。
- persistent 默认关闭；开启后默认 `scope: "provider"`、`poolSize: 1`、`idleTimeoutMs: 300_000`。

### 4.2 Thread 默认值

```ts
type CodexThreadDefaults = {
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  ephemeral?: boolean;
};
```

这些值用于 `thread/start`，也会在 resume 时用于 `thread/resume` 的对应覆盖字段。

### 4.3 Turn 默认值

```ts
type CodexTurnDefaults = {
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed" | "none";
};
```

这些值用于 `turn/start`，可被 per-call `codexCallOptions()` 覆盖。

### 4.4 Custom model provider

```ts
type CodexModelProviderInfo = {
  name?: string;
  base_url?: string;
  env_key?: string;
  env_key_instructions?: string;
  experimental_bearer_token?: string;
  wire_api?: "responses";
  query_params?: Record<string, string>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  request_max_retries?: number;
  stream_max_retries?: number;
  stream_idle_timeout_ms?: number;
  websocket_connect_timeout_ms?: number;
  requires_openai_auth?: boolean;
  supports_websockets?: boolean;
};
```

provider 会把 `modelProvider` 与 `customModelProviders` 转成 app-server thread config：

```json
{
  "model_provider": "my_provider",
  "model_providers": {
    "my_provider": {
      "name": "my_provider",
      "base_url": "https://example.test/v1",
      "experimental_bearer_token": "...",
      "wire_api": "responses",
      "requires_openai_auth": false
    }
  }
}
```

dasCowork 当前从 admin backend model 生成该配置：

- `modelProvider = clientModel.provider`
- `base_url = clientModel.api_base_url`
- `wire_api = "responses"`
- `requires_openai_auth = false`
- `supports_websockets = false`
- `experimental_bearer_token = clientModel.api_key`，仅在 main process / provider / app-server 边界内流动

## 5. Per-call API

### 5.1 `codexCallOptions()`

`codexCallOptions()` 把 Codex 专属参数包装进 AI SDK `providerOptions`：

```ts
const result = streamText({
  model: codex.chat(modelId),
  messages,
  providerOptions: codexCallOptions({
    resumeThreadId: "thread_123",
    cwd: "/absolute/project",
    runtimeWorkspaceRoots: ["/absolute/project"],
    model: modelId,
    effort: "high",
    summary: "auto",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite" },
  }),
});
```

展开后形态：

```ts
{
  [CODEX_PROVIDER_ID]: {
    resumeThreadId?: string;
    cwd?: string;
    runtimeWorkspaceRoots?: string[];
    approvalPolicy?: AskForApproval;
    approvalsReviewer?: ApprovalsReviewer;
    sandbox?: SandboxMode;
    ephemeral?: boolean;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    model?: string;
    sandboxPolicy?: SandboxPolicy;
    summary?: "auto" | "concise" | "detailed" | "none";
    collaborationMode?: {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string | null;
        developer_instructions: string | null;
      };
    };
    /** Existing-thread Goal control; it never creates a user turn. */
    goalControlObjective?: string;
    onThreadGoalUpdated?: (event: {
      threadId: string;
      goal: ThreadGoal | null;
    }) => void | Promise<void>;
    approvals?: CodexApprovalCallbacks;
  }
}
```

优先级：

1. per-call `codexCallOptions()`
2. provider `defaultThreadSettings` / `defaultTurnSettings`
3. app-server 默认配置

### 5.1.1 Collaboration Mode 与线程 Goal

`collaborationMode` 会原样写入 `turn/start.collaborationMode`；它不是追加到 user 或 system prompt 的文本。Desktop Renderer 只可提交 `default | plan` 枚举，Main 使用 `collaborationMode/list` 的 preset 和当前模型补齐完整 settings，并且每一轮都显式发送 Default 或 Plan，避免恢复 thread 后沿用旧模式。

`CodexHistoryClient` 提供 `listCollaborationModes()` 及 `getThreadGoal()`、`setThreadGoal()`、`clearThreadGoal()`。无活动 owner 的读取和清除可以使用短连接；设置已有线程 Goal 必须传 `goalControlObjective`，provider 会创建 `CodexConversationSession`，依次 `thread/resume`、应用当前 thread settings，并由 `onSessionCreated` 在**同一条连接**发送 `thread/goal/set`，不发送 `turn/start`、不增加用户消息。新会话仍先完成唯一一次正常 `turn/start`，再在同一 session 写入 Goal。

Goal session 使用 `goalContinuous` policy：自动 Goal turn 的 `turn/completed` 仅是一个 turn 边界，不关闭 conversation owner；终态 Goal、clear-drain、abort 或 transport error 才结束该 session。普通单轮聊天与 Goal 共享连接、审批和 packet mapper 基础设施。

Goal 更新通知会通过 `onThreadGoalUpdated` 返回。调用方只能把必要的目标摘要传给 Renderer，不能把 app-server settings、provider 凭据或原始 protocol packet 透传出去。

### 5.2 Thread continuation（创建新 turn）

provider 支持两种恢复 thread 并提交**下一条用户输入**的方式：

1. 显式传 `codexCallOptions({ resumeThreadId })`。
2. 从前一次 assistant message 或 content part 的 `providerOptions[CODEX_PROVIDER_ID].threadId` 中反推。

stream 输出会在 `providerMetadata[CODEX_PROVIDER_ID]` 放入：

```ts
{
  threadId?: string;
  turnId?: string;
  threadPath?: string;
}
```

dasCowork 主进程用这个 metadata 提取 `threadId` / `turnId`，同步 conversation 状态。

这条路径的语义是「继续同一 thread」，不是「接回同一运行中的 turn」：它会在 `thread/resume` 后发送新的 `turn/start`。因此不能用于 renderer 刷新、IPC 端口短断或 app-server transport 重建时的 active-turn 恢复；把旧输入重新传入这个路径会造成重复执行风险。

### 5.3 Active-turn reattach（不创建新 turn）

桌面端在已知 `resumeThreadId` 和仍在运行的 `turnId` 时，可额外传入：

```ts
codexCallOptions({
  resumeThreadId,
  resumeActiveTurn: true,
  existingTurnRecoveryState,
  onExistingTurnRecoveryState: (state) => persistRecoveryState(state),
});
```

这是一条恢复专用路径：provider 只执行 `initialize`、`initialized`、`thread/resume`，从 response 的 active turn snapshot 还原 text/item 状态，再接收同一 turn 的后续通知。它**绝不发送 `turn/start`**，也不重放旧 prompt。若 response 不含仍在运行的目标 turn，provider 以可识别的“active turn unavailable”错误结束；desktop main 必须保留已收到的历史并收敛为 `interrupted`，而不是自动开始新 turn。

`existingTurnRecoveryState` 是 provider 的内部快照，包含已映射的文本和 item 状态；host 只应为同一 active run 原样保存/回传，不能把它跨 thread、跨 turn 或跨用户重试复用。

### 5.4 首轮立即创建会话入口

当 UI 需要用户一发送消息就显示会话入口，而不是等到 LLM 首个 stream chunk 返回后再显示，应把回调挂在同一次 `streamText()` 的 provider options 上：

```ts
const result = streamText({
  model: codex.chat(modelId, modelSettings),
  messages,
  providerOptions: codexCallOptions({
    cwd,
    runtimeWorkspaceRoots,
    approvalPolicy,
    approvalsReviewer,
    sandbox,
    model: modelId,
    summary: "auto",
    onThreadStarted: ({ threadId, threadPath }) => {
      // 这里已经拿到 app-server 真实 threadId；
      // provider 随后会在同一条连接上发送首个 turn/start。
      showConversationInSidebar({ threadId, threadPath });
    },
  }),
});
```

`onThreadStarted` 会在 provider 收到 `thread/start` 结果后、发送首个 `turn/start` 前触发。provider 会执行回调的同步部分，但不会等待它返回的 Promise；异步保存、广播等 host 侧副作用应自行捕获错误，不能阻塞首个 `turn/start`。这样 UI 可以立即使用真实 `threadId` 创建入口，同时避免“独立 `startThread()` 连接创建空线程，再由另一条连接 `thread/resume` 首轮消息”导致刚创建的 rollout 不在当前 app-server worker 中的问题。

## 6. JSON-RPC 生命周期

### 6.1 常规 `streamText()` / `generateText()`

正常新 thread 的 RPC 顺序：

```text
connect transport
request      initialize
notification initialized
request      thread/start
request      turn/start
notifications turn/*, item/*, thread/*
notification turn/completed
disconnect transport
```

恢复已有 thread 并创建下一 turn 的 RPC 顺序：

```text
connect transport
request      initialize
notification initialized
request      thread/resume
optional     thread/compact/start
request      turn/start
notifications turn/*, item/*, thread/*
notification turn/completed
disconnect transport
```

重新附加仍在运行的 turn 的 RPC 顺序：

```text
connect transport
request      initialize
notification initialized
request      thread/resume
notifications existing turn snapshot, turn/*, item/*, thread/*
notification turn/completed
disconnect transport
```

该 reattach 分支没有 `turn/start`，也不会执行 resume 后的 compact。只有 app-server 返回的 active turn 与调用方持有的 `turnId` 相同，才允许继续消费 live event；不匹配或缺失时由 host 安全结算为 interrupted。

开启 provider-local persistent pool 时，同一个 worker 上后续调用会复用 `initialize` 结果，不再真实发送第二次 `initialize` / `initialized`。desktop host 则通过 `CodexAppServerConnection` 的 broker 在所有 logical channel 间共享一次 initialize 和一条物理连接。

### 6.2 `initialize`

请求：

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "dascowork_desktop",
      "title": "dasCowork Desktop",
      "version": "1.0.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}
```

规则：

- `clientInfo` 来自 provider settings；未提供时使用 package name/version。
- 当 `experimentalApi: true` 或存在动态工具时，provider 会发送 `capabilities.experimentalApi = true`。
- provider 随后发送 `initialized` notification。

### 6.3 `thread/start`

provider 当前会构造：

```ts
{
  model,
  modelProvider,
  dynamicTools,
  developerInstructions,
  config,
  cwd,
  runtimeWorkspaceRoots,
  approvalPolicy,
  approvalsReviewer,
  sandbox,
  ephemeral,
}
```

来源：

- `model`：语言模型实例的 `modelId`，fallback 到 provider `defaultModel`。
- `modelProvider` / `config`：由 custom model provider 与 MCP 配置合并。
- `dynamicTools`：provider-level tools 与 AI SDK tools 的 schema。
- `developerInstructions`：AI SDK system messages 合并后生成。
- `cwd` / `runtimeWorkspaceRoots` / `approvalPolicy` / `approvalsReviewer` / `sandbox` / `ephemeral`：per-call 覆盖或 thread 默认值。

兼容性提示：

- 当前 provider 会把 `runtimeWorkspaceRoots` 也放到 `thread/start`。仓库内 official schema 的 `ThreadStartParams` 未列出该字段；对接目标 app-server 版本时需要确认是否接受。
- official schema 的 `ThreadStartParams` 还包含 `serviceName`、`baseInstructions`、`personality`、`sessionStartSource`、`threadSource` 等字段；provider 当前没有公开对应 settings。

### 6.4 `thread/resume`

provider 当前会构造：

```ts
{
  threadId,
  developerInstructions,
  modelProvider,
  config,
  cwd,
  runtimeWorkspaceRoots,
  approvalPolicy,
  approvalsReviewer,
  sandbox,
  model,
}
```

常规 continuation 中，`thread/resume` response 的 `thread.id` 是后续 `turn/start.threadId` 的来源。provider 也会读取 `thread.path`，写入 stream-start 的 `providerMetadata.threadPath`。active-turn reattach 同样读取该 response，但只消费其中的 active turn snapshot 和后续事件，不发 `turn/start`。

### 6.5 `thread/compact/start`

仅在 resume 后、`turn/start` 前触发。

配置：

```ts
compaction: {
  shouldCompactOnResume?: boolean | ((ctx) => boolean | Promise<boolean>);
  strict?: boolean;
}
```

行为：

- `shouldCompactOnResume` 为 true 或回调返回 true 时发送 `{ threadId }`。
- `strict: false` 或未设置时，压缩失败只记录 debug，不阻断本 turn。
- `strict: true` 时，压缩失败会让本次 AI SDK 调用失败。

### 6.6 `turn/start`

provider 当前会构造：

```ts
{
  threadId,
  input,
  cwd,
  runtimeWorkspaceRoots,
  approvalPolicy,
  approvalsReviewer,
  sandboxPolicy,
  model,
  effort,
  summary,
  outputSchema,
}
```

规则：

- `input` 由 AI SDK prompt 映射生成。
- `outputSchema` 来自 AI SDK `responseFormat.type === "json"` 时的 schema。
- `cwd`、`runtimeWorkspaceRoots`、`approvalPolicy`、`approvalsReviewer` 等 per-call 值会覆盖 provider 默认值。

### 6.7 Abort / cancel

当 AI SDK `abortSignal` 触发或 stream consumer cancel：

```json
{
  "method": "turn/interrupt",
  "params": {
    "threadId": "...",
    "turnId": "..."
  }
}
```

`turn/interrupt` 的 RPC response 仅表示控制请求已结算，不表示 turn 已结束。桌面端把用户 stop 作为 intent：继续消费同一 App Server 连接上的 `turn/completed`，并只按匹配的 canonical status 决定 UI terminal：

- `completed` -> finish；
- `interrupted` -> aborted；
- `failed` -> error。

若 completion notification 在 deadline 前缺失，桌面端会经同一 host-scoped connection 执行严格的 `thread/read(includeTurns: true)` 对账。无法确认时返回脱敏 error，而不会伪造 `aborted`。用户 stop 不会关闭物理 App Server connection；history、catalog 和控制请求仍可复用其逻辑通道并发执行。

## 7. Prompt 映射

### 7.1 System messages

所有 AI SDK system message 会 trim 后用空行拼接，作为 `thread/start` 或 `thread/resume` 的 `developerInstructions`。

### 7.2 User content -> `turn/start.input`

Codex App Server `UserInput` 形态：

```ts
type UserInput =
  | { type: "text"; text: string; text_elements: TextElement[] }
  | { type: "image"; url: string; detail?: ImageDetail }
  | { type: "localImage"; path: string; detail?: ImageDetail }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };
```

provider 当前映射规则：

- fresh thread：累积所有 user message 中的文本；遇到图片前 flush 文本，以保留图文顺序。
- resumed thread：只取最后一条 user message。
- text part：trim 后变为 `{ type: "text", text, text_elements: [] }`。
- text file：inline data 解码成 text；URL text file 不 fetch，只把 URL 字符串作为 text。
- image file URL：
  - `file:` URL -> `{ type: "localImage", path }`
  - `http(s):` URL -> `{ type: "image", url }`
- inline image data：先写入临时文件，再映射为 `localImage`；turn 结束后 best-effort 清理。
- 非 text / image 文件会被跳过。

## 8. Stream event 映射

provider 通过 `CodexEventMapper` 把 app-server notifications 映射为 AI SDK `LanguageModelV3StreamPart`。

| App Server 通知                               | AI SDK stream part                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `turn/started`                                | 确保发送 `stream-start`，记录 `turnId`                                                  |
| `item/started` + `agentMessage`               | `text-start`                                                                            |
| `item/agentMessage/delta`                     | `text-delta`                                                                            |
| `item/completed` + `agentMessage`             | 必要时补 `text-delta`，然后 `text-end`                                                  |
| `item/reasoning/textDelta`                    | `reasoning-start` / `reasoning-delta`                                                   |
| `item/reasoning/summaryTextDelta`             | `reasoning-start` / `reasoning-delta`                                                   |
| `item/reasoning/summaryPartAdded`             | `reasoning-delta`，内容为空行                                                           |
| `item/plan/delta`                             | `reasoning-start` / `reasoning-delta`                                                   |
| `turn/plan/updated`                           | provider-executed `codex_plan_update` tool-call/tool-result                             |
| `item/started` + `commandExecution`           | provider-executed `codex_command_execution` tool-call                                   |
| `item/started` + `fileChange`                 | provider-executed `codex_file_change` tool-call                                         |
| `item/started` + `mcpToolCall`                | provider-executed `mcp:<server>/<tool>` tool-call                                       |
| `item/started` + `collabAgentToolCall`        | provider-executed `codex_collab_agent` tool-call                                        |
| `item/completed` for tracked native tool item | matching `tool-result`                                                                  |
| `item/mcpToolCall/progress`                   | preliminary `tool-result` with status message                                           |
| `item/tool/callStarted`                       | `tool-input-start`                                                                      |
| `item/tool/callDelta`                         | `tool-input-delta`                                                                      |
| `item/tool/callFinished`                      | `tool-input-end`                                                                        |
| `item/tool/call` 被路由进 mapper 时           | dynamic tool-call；主链路的 server request 由 tool dispatcher / cross-call handler 处理 |
| `thread/tokenUsage/updated`                   | cache latest usage for final `finish`                                                   |
| `item/completed` + `imageGeneration`          | `file` part, `mediaType: "image/png"`                                                   |
| `error`                                       | 当前不直接 emit AI SDK error；等待 terminal `turn/completed.turn.error`                 |
| `turn/completed`                              | close open text/reasoning/tool parts；失败时 emit `error`，随后 emit `finish`           |

Error mapping：

- App Server Protocol 的 mid-turn `error` notification 形态是 `{ error: TurnError, willRetry, threadId, turnId }`，其中 `TurnError` 为 `{ message, codexErrorInfo, additionalDetails }`。该 notification 可能先于 terminal `turn/completed` 到达，并且 `willRetry` 为 true 时不一定代表本 turn 已终止。
- 当前 provider 不把 mid-turn `error` notification 直接映射为 AI SDK error part，避免 retry 中间态在 UI 上重复或过早报错。
- 当前 provider 以 terminal `turn/completed.turn.error` 为准：当 `turn.status === "failed"` 且 `turn.error.message` 非空时，emit AI SDK `LanguageModelV3StreamPart`：`{ type: "error", error: new Error(turn.error.message) }`。
- AI SDK `toUIMessageStream()` 会把该 provider error part 转成 UI chunk：`{ type: "error", errorText }`；调用方需要通过 `onError` 决定暴露给 renderer 的错误文本。

Finish reason mapping：

- `completed` -> `{ unified: "stop", raw: "completed" }`
- `failed` -> `{ unified: "error", raw: "failed" }`
- `interrupted` -> `{ unified: "other", raw: "interrupted" }`
- unknown -> `{ unified: "other" }`

故意忽略的通知：

- `codex/event/agent_reasoning`
- `codex/event/agent_reasoning_section_break`
- `codex/event/plan_update`
- `codex/event/web_search_begin`
- `codex/event/web_search_end`
- `codex/event/mcp_tool_call_begin`
- `codex/event/mcp_tool_call_end`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `error`（mid-turn error / retry notification；当前等待 terminal `turn/completed.turn.error`）
- `turn/diff/updated`
- `codex/event/turn_diff`

原因：这些要么有 canonical item/turn 通知替代，要么体积较大，不适合直接塞进通用 stream part。

## 9. Dynamic Tools

provider 支持两类工具：

1. Provider-level tools：`CodexProviderSettings.tools`
2. AI SDK call-level tools：`streamText({ tools })`

### 9.1 Provider-level tools

```ts
const codex = createCodexAppServer({
  experimentalApi: true,
  tools: {
    lookup_ticket: {
      description: "Look up a support ticket.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      execute: async (args, context) => ({
        success: true,
        contentItems: [{ type: "inputText", text: "Ticket is open." }],
      }),
    },
  },
});
```

provider 会：

- 在 `thread/start.dynamicTools` 中广告 schema。
- 通过 `DynamicToolsDispatcher` 监听 app-server server request `item/tool/call`。
- 把 `params.arguments ?? params.input` 传给 handler。
- 返回 `CodexToolCallResult`。

结果形态：

```ts
type CodexToolCallResult = {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
};
```

### 9.2 AI SDK tools 与 cross-call

AI SDK `tools` 会被转换成 `dynamicTools` schema。若 app-server 请求 `item/tool/call`：

- provider 向 AI SDK stream 发 `tool-call`。
- provider 用 `finishReason: "tool-calls"` 结束当前 step。
- tool result 会在下一次 AI SDK step 的 prompt 里出现。
- persistent transport 按 `threadId` 找回同一 continuation，把 tool result 回写给 app-server；desktop broker 将 continuation 保存在 host-scoped connection 中，而不是依赖 worker affinity。

因此：标准 AI SDK tool 流程要求开启 persistent transport；desktop 使用 host-scoped broker 来可靠跨 step 续接同一个 app-server connection。

### 9.3 Legacy `toolHandlers`

`toolHandlers` 只注册 handler，不会把 schema 广告给 Codex。新代码优先使用 `tools`。

## 10. Approvals / Elicitation

provider 通过 `ApprovalsDispatcher` 处理 app-server 发起的 JSON-RPC server request。

| App Server request                      | provider callback                 | 默认行为                                                   |
| --------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `item/commandExecution/requestApproval` | `approvals.onCommandApproval`     | `decline`                                                  |
| `item/fileChange/requestApproval`       | `approvals.onFileChangeApproval`  | `decline`                                                  |
| `item/tool/requestUserInput`            | `approvals.onToolUserInput`       | 每个问题选第一个 option                                    |
| `item/permissions/requestApproval`      | `approvals.onPermissionsApproval` | `{ permissions: {}, scope: "turn" }`（未配置 callback 时） |
| `mcpServer/elicitation/request`         | `approvals.onElicitation`         | `{ action: "accept", content: null, _meta: null }`         |

Command approval handler 返回：

```ts
type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: string; action: "allow" | "deny" };
      };
    }
  | "decline"
  | "cancel";
```

File change approval handler 返回：

```ts
type FileChangeApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel";
```

dasCowork 当前把这些 callback 转发到 `CodexApprovalBroker`，再由 renderer 审批面板回答。

文件审批的 server request 本身不含 patch。`ApprovalsDispatcher` 会在 provider 内按
`threadId + turnId + itemId` 缓存 `item/started` 和
`item/fileChange/patchUpdated` 通知中的 `changes`，并把下列增强字段交给
`onFileChangeApproval`：

```ts
type CodexFileChangeApprovalRequest = FileChangeRequestApprovalParams & {
  changes: Array<{
    path: string;
    kind: "add" | "delete" | "update";
    diff: string;
  }>;
};
```

缓存会在 item/turn 完成和 dispatcher detach 时清除，不跨 thread 或 turn 复用。

桌面端不会把完整 app-server 参数交给 renderer。Main 只将命令、cwd、原因、网络
host/协议、文件 path/diff、逐项白名单化的 permission detail、结构化问题和经过白名单转换的 MCP 字段发送到审批面板；
renderer 只提交稳定 intent，Main 再从原请求的 `availableDecisions` 取回精确 policy
对象；权限卡只回传 `turn`/`session` scope，Main 才从原始 request 取回完整 profile。秘密输入只作为一次回答存在，不进入 pending snapshot。

命令审批保留 `availableDecisions` 的三态：缺失或 `null` 才按 App Server 历史规则推导；
显式数组完全权威；显式空数组、未知 decision 或畸形 amendment 在 Main 中直接
fail closed 为 `cancel`，不会发布 Renderer 卡片。命令和文件审批分别保留
`decline`（拒绝但继续 turn）与 `cancel`（拒绝并中断 turn），Main 只接受当前请求允许的
用户动作。可选 MCP number/integer 输入清空后从提交值省略，非空值转换为有限 number 后
再执行 integer、minimum 和 maximum 校验。

注意：

- command / file 默认拒绝较安全。
- MCP elicitation 默认接受，集成 UI 应显式提供 `onElicitation`，避免副作用 tool 静默放行。
- 未配置 `onPermissionsApproval` 时仍 fail closed；配置后只可由 Main 按原始 profile 重建 grant，renderer 不能注入路径、host 或 `strictAutoReview`。
- typed MCP `form` 和安全编译成功的 `openai/form` 支持文本、number/integer、boolean、单选 enum 和 string-array 多选；任一字段或约束无法完整编译时整表 fail closed，绝不渲染原始 schema。MCP 的 `accept`、`decline`、`cancel` 分别保留，且不伪造 session/always 持久化语义。

## 11. Session API

`onSessionCreated` 可以拿到本轮 active session：

```ts
type CodexSession = {
  readonly threadId: string;
  readonly turnId: string | undefined;
  isActive(): boolean;
  injectMessage(input: string | UserInput[]): Promise<void>;
  steerPrompt(
    prompt: LanguageModelV3Prompt,
    options: { clientUserMessageId: string },
  ): Promise<{ turnId: string }>;
  interrupt(): Promise<void>;
};
```

行为：

- `injectMessage()` 当前发送 `turn/start`，由 app-server 在 active turn 下路由成 steer input；没有直接使用 `turn/steer`。
- `steerPrompt()` 直接发送 `turn/steer`，复用当前 session 的附件解析器，携带最新
  `expectedTurnId` 和稳定 `clientUserMessageId`，绝不降级成 `turn/start`。
- `CodexSteerError.code === "steer_result_unknown"` 表示请求已经发出但结果无法确认；
  调用方必须暂停等待用户决定，不能自动重试。
- `interrupt()` 发送 `turn/interrupt`，需要已有 `turnId`。
- stream 完成、错误、abort 后 session 会标记 inactive。

## 12. Transport API

### 12.1 `CodexTransport`

```ts
type CodexTransport = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(message: JsonRpcMessage): Promise<void>;
  sendNotification(method: string, params?: unknown): Promise<void>;
  on(event, listener): () => void;
};
```

JSON-RPC message 不包含 `jsonrpc: "2.0"` 字段。

### 12.2 `StdioTransport`

配置：

```ts
type StdioTransportSettings = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
```

默认：

```text
command = "codex"
args = ["app-server", "--listen", "stdio://"]
```

传输规则：

- 每条 outbound JSON-RPC message 以 `JSON.stringify(message) + "\n"` 写入 stdin。
- stdout 按行解析 JSON。
- stderr 只缓存最近 64 KiB，用于进程非 0 退出时报错。

### 12.3 `WebSocketTransport`

配置：

```ts
type WebSocketTransportSettings = {
  url?: string;
  headers?: Record<string, string>;
};
```

默认 URL：`ws://localhost:3000`

传输规则：

- outbound message 直接 `socket.send(JSON.stringify(message))`。
- inbound 只处理 string message。
- 依赖 runtime 提供 `globalThis.WebSocket`。

### 12.4 Persistent transport

开启：

```ts
const codex = createCodexAppServer({
  persistent: {
    scope: "provider",
    poolSize: 1,
    idleTimeoutMs: 300_000,
  },
});
```

能力：

- 池化 app-server worker，减少每次启动进程成本。
- 缓存 initialize result；同一 worker 后续调用不重复真实 initialize。
- 保留 pending `item/tool/call`，支撑 AI SDK tools 跨 step 返回结果。
- worker acquisition 会优先按 pending tool call 的 `threadId` 做 affinity。

scope：

- `provider`：每个 provider 实例独占 pool。
- `global`：同 key 共享 pool；不同 `poolSize` / `idleTimeoutMs` 会报错。

## 13. Thread History Mapper

`mapCodexThreadTurnsToUiMessages()` 把 app-server `Turn[]` 转成 AI SDK UI messages，用于历史会话回放。

输入：

```ts
type CodexThreadHistoryMappingInput = {
  threadId?: string;
  threadPath?: string | null;
  turns: Turn[];
};
```

主要映射：

- `userMessage` -> `role: "user"`，支持 text/image/localImage/skill/mention。
- `agentMessage` -> text UI part。
- `reasoning` / `plan` -> reasoning UI part。
- `commandExecution` -> dynamic-tool `codex_command_execution`。
- `fileChange` -> dynamic-tool `codex_file_change`。
- `mcpToolCall` -> dynamic-tool `mcp:<server>/<tool>`。
- `dynamicToolCall` -> dynamic-tool `<tool>`。
- `collabAgentToolCall` -> dynamic-tool `codex_collab_agent`。
- `webSearch` -> dynamic-tool `codex_web_search`。
- `imageGeneration` -> file part，`mediaType: "image/png"`。

## 14. dasCowork 当前桌面配置

本节之前的 provider API 是兼容包的历史/仓库外 consumer 参考，不描述
desktop 的生产执行路径。桌面现在由下列边界直接驱动 app-server：

- `desktop-app/src/main/codexRun/HostCodexConnection.ts` 负责每个 host
  generation 的版本探针和唯一 `initialize` / `initialized`。
- `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts` 编排
  `thread/start` / `thread/resume`、`turn/start`、interrupt、恢复和审批。
- `desktop-app/src/main/codexRun/CodexRunInputAdapter.ts` 与
  `CodexUiMessageAdapter.ts` 是 Main 的 UI 适配边界。
- `desktop-app/vendors/codex-app-server-client/` 拥有 AI-free transport、
  中性事件和唯一 generated protocol tree。

桌面不再从 `streamText()`、`codexCallOptions()` 或
`CodexLanguageModel` 构造聊天调用。

launch 解析顺序：

1. `CODEX_APP_SERVER_BIN`
2. 默认执行 `codex app-server --listen stdio://`

`CODEX_APP_SERVER_BIN` 仅保留给测试替身，正常开发和安装包运行都依赖用户本机已经安装、已登录、且在 GUI 进程 `PATH` 中可见的 Codex CLI。安装包不包含 Rust `codex-app-server` 二进制，也不会自动扫描或下载 CLI。

环境处理：

- 过滤 `CODEX_CI`、`CODEX_THREAD_ID`、`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`。
- 自动把 `localhost`、`127.0.0.1`、`::1` 加入 `NO_PROXY` / `no_proxy`。
- debug packet logger 会递归 redacts `authorization`、`api_key`、`experimental_bearer_token`、`token`、`secret` 等字段。

## 15. 对接 official app-server notes 的注意事项

1. provider 是 official app-server API 的子集 adapter，不是完整 app-server SDK。
2. provider 当前主路径只覆盖 chat language model、model/list、thread start/resume/compact、turn start/interrupt、动态工具、审批和通知映射。
3. official notes 中的 `thread/read`、`thread/list`、`thread/fork`、`review/start`、`command/exec`、`fs/*`、`account/*`、`skills/*`、`plugin/*` 等 API 不由 `CodexLanguageModel` 暴露；desktop 新增能力应落在 Main-owned native driver 或明确的 Main service，不能向 renderer 暴露原始 RPC。
4. provider 与 desktop 都依赖 `@dascowork/codex-app-server-client` 的唯一 generated protocol tree。升级 app-server 时只在 core 运行 `codex app-server generate-ts`，然后执行协议、边界和真实 app-server contract 验证。
5. `dynamicTools`、`process/*`、部分 provider capability 属于 experimental API；provider 会在有工具或显式配置时发送 `capabilities.experimentalApi = true`。
6. standard AI SDK tools 的跨 step 工作流依赖 persistent transport；桌面当前使用 host-scoped broker 的单一 physical connection，而不是 `poolSize: 1` 的串行 worker。
7. `thread/start` 的 `runtimeWorkspaceRoots` 字段需要按目标 app-server schema 复核。
8. app-server official response shape 常见为 `{ thread: { id } }`、`{ turn: { id } }`；provider 也兼容旧的 `{ threadId }`、`{ turnId }`。
9. MCP elicitation 默认接受，dasCowork 已接入审批 broker；后续新增入口时不要遗漏 `onElicitation`。
10. sensitive model provider fields 只能停留在 main process / provider / app-server 边界内，不应进入 renderer。

## 16. 验证命令

provider 层：

```bash
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run test
```

core 与协议层：

```bash
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:real-codex-app-server-contract
```

desktop 层：

```bash
npm --prefix desktop-app run lint
npm --prefix desktop-app test
```

聊天链路 / 模型供应商：

```bash
npm --prefix desktop-app run test:e2e -- --reporter=line
```

## 17. 证据索引

- Core JSON-RPC client / stdio transport：`desktop-app/vendors/codex-app-server-client/src/client/`
- Core event normalizer：`desktop-app/vendors/codex-app-server-client/src/run-events/CodexRunEventNormalizer.ts`
- Desktop host connection / version policy：`desktop-app/src/main/codexRun/HostCodexConnection.ts`、`codexAppServerVersionPolicy.ts`
- Desktop native driver 与 UI adapters：`desktop-app/src/main/codexRun/NativeCodexRunDriver.ts`、`CodexRunInputAdapter.ts`、`CodexUiMessageAdapter.ts`
- Compatibility provider export、AI SDK lifecycle 与 history mapper：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/index.ts`、`model.ts`、`history-mapper.ts`
- Compatibility provider protocol adapters：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/`
- app-server launch：`desktop-app/src/main/codexAppServerLaunch.ts`
- official notes：`codex-app-server-official-notes.md`
