# Codex App Server 官方文档整理

来源：[Codex App Server - OpenAI Developers](https://developers.openai.com/codex/app-server)

整理日期：2026-07-02

说明：本文是基于 OpenAI 官方 Codex App Server 文档整理的本地 Markdown 参考，不是官方页面的完整逐字副本。为便于本项目查阅，保留了协议名、RPC method、字段名和关键命令，正文以中文归纳。

## 定位

Codex App Server 是 Codex 用来支撑富客户端集成的本地接口，例如 IDE 扩展或桌面产品。它适合需要深度集成 Codex 的场景，包括认证、会话历史、审批流和 agent 事件流。

如果目标只是自动化任务、CI 或脚本式运行 Codex，官方建议优先看 Codex SDK，而不是直接对接 App Server。

本仓库相关实现位置：

- `codex/codex-rs/app-server/`
- `codex/codex-rs/app-server-protocol/`
- `desktop-app/vendors/codex-app-server-client/`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/`

## 协议

App Server 使用类似 JSON-RPC 2.0 的双向通信模型，但线上消息不会携带 `jsonrpc: "2.0"` 字段。请求、响应和通知都以 JSON 对象表示。

支持的 transport：

- `stdio`：默认 transport，可用 `--listen stdio://`，消息是逐行 JSON。
- `websocket`：`--listen ws://IP:PORT`，当前属于实验和未正式支持的 transport。
- `unix` socket：`--listen unix://` 或 `--listen unix://PATH`，通过 HTTP Upgrade 建立 WebSocket。
- `off`：`--listen off`，不暴露本地 transport。

WebSocket 模式还提供基础健康检查：

- `GET /readyz`：listener 可接受连接后返回成功。
- `GET /healthz`：无 `Origin` header 时返回成功。
- 带 `Origin` header 的请求会被拒绝。

WebSocket 如果绑定非 loopback 地址，需要配置认证后再暴露到远端。官方列出的认证方向包括 capability token 和 signed bearer token。推荐通过文件传递 token，而不是把原始 bearer token 放在命令行参数中。

当 WebSocket 请求队列满时，服务器会返回 JSON-RPC 错误码 `-32001`，语义是服务端过载，客户端应使用带 jitter 的指数退避重试。

## Message Schema

请求包含 `method`、`id` 和可选 `params`。响应复用请求的 `id`，成功时返回 `result`，失败时返回 `error`。通知没有 `id`。

示例：

```json
{ "method": "thread/start", "id": 1, "params": { "model": "gpt-5.4" } }
{ "id": 1, "result": { "thread": { "id": "thr_example" } } }
{ "method": "turn/started", "params": { "turn": { "id": "turn_example" } } }
```

可以通过 CLI 为当前 Codex 版本导出协议 schema：

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

导出的 TypeScript 或 JSON Schema 与执行该命令的 Codex 版本对应。

## 快速开始

典型流程：

1. 启动 server：`codex app-server`、`codex app-server --listen ws://127.0.0.1:4500` 或 `codex app-server --listen unix://`。
2. 客户端连接所选 transport。
3. 发送 `initialize` 请求，再发送 `initialized` 通知。
4. 调 `thread/start` 或 `thread/resume`。
5. 调 `turn/start`，随后持续读取 `thread/*`、`turn/*`、`item/*` 等通知。

最小 stdio 客户端思路：

```ts
import { spawn } from "node:child_process";

const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],
});

function send(message: unknown) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "my_product",
      title: "My Product",
      version: "0.1.0",
    },
  },
});

send({ method: "initialized", params: {} });
send({ method: "thread/start", id: 1, params: { model: "gpt-5.4" } });
```

## 核心对象

- Thread：用户与 Codex agent 的一次会话。一个 thread 包含多个 turn。
- Turn：一次用户请求和随后发生的 agent 工作。一个 turn 包含多个 item，并会流式更新。
- Item：输入或输出单元，例如用户消息、agent 消息、命令执行、文件修改、MCP tool call 等。

一般用 thread API 创建、恢复、读取或归档会话；用 turn API 驱动对话；用通知流渲染进度和结果。

## 生命周期

连接级别：

1. 每个连接只初始化一次。
2. 先发 `initialize`，再发 `initialized`。
3. 初始化前发送其他请求会失败。
4. 重复初始化同一连接也会失败。

会话级别：

1. `thread/start` 创建新会话。
2. `thread/resume` 恢复已有会话。
3. `thread/fork` 从已有会话分叉。
4. `turn/start` 开始一次用户输入。
5. `turn/steer` 可向正在运行的 turn 追加输入。
6. `turn/interrupt` 请求中断正在运行的 turn。

事件级别：

- `thread/started` 表示 thread 已启动并订阅事件。
- `turn/started` 表示 turn 开始运行。
- `item/started` 和 `item/completed` 表示一个工作单元的生命周期。
- `item/agentMessage/delta` 等 delta 通知用于流式输出。
- `turn/completed` 表示 turn 完成、失败或被中断。

## Initialize

`initialize` 需要带 `clientInfo`。对企业集成来说，`clientInfo.name` 会用于合规日志识别；如果是新的企业级 Codex 集成，官方建议联系 OpenAI 将客户端加入已知客户端列表。

可选能力：

- `capabilities.experimentalApi`：启用实验 API。
- `capabilities.optOutNotificationMethods`：按精确 method 名称禁用某些通知。

示例：

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "my_client",
      "title": "My Client",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true,
      "optOutNotificationMethods": ["thread/started", "item/agentMessage/delta"]
    }
  }
}
```

## Experimental API

部分 method 或字段需要 `capabilities.experimentalApi = true`。如果客户端没有 opt in，server 会拒绝实验 method 或实验字段，并返回需要 experimental capability 的错误。

建议：

- 稳定客户端默认不要开启实验 API。
- 调用 `process/*`、`dynamicTools`、部分 background terminal、部分 model provider capability 等功能前，先明确开启实验能力。

## API Overview

### Thread

- `thread/start`：创建新 thread，并自动订阅其 turn/item 事件。
- `thread/resume`：恢复已有 thread，后续 `turn/start` 会追加到该会话。
- `thread/fork`：复制已有历史并生成新 thread。
- `thread/read`：读取已保存 thread，但不恢复、不订阅。
- `thread/list`：分页查询历史 thread。
- `thread/turns/list`：分页查询某个 thread 的 turn 历史。
- `thread/loaded/list`：列出当前内存中已加载的 thread。
- `thread/name/set`：设置或更新用户可见名称。
- `thread/goal/set`、`thread/goal/get`、`thread/goal/clear`：管理持久化 goal。
- `thread/metadata/update`：更新持久化元数据，目前包括 `gitInfo`。
- `thread/archive`、`thread/unarchive`：归档和恢复归档。
- `thread/delete`：永久删除持久化 thread 和其 spawned descendant。
- `thread/unsubscribe`：取消当前连接对 loaded thread 的订阅。
- `thread/compact/start`：触发手动上下文压缩。
- `thread/shellCommand`：执行用户发起、隶属于 thread 的 shell 命令。
- `thread/rollback`：回滚最近若干 turn，目前文档标注为旧/谨慎使用能力。
- `thread/inject_items`：向 loaded thread 的模型可见历史插入 Responses API items。

### Turn

- `turn/start`：添加用户输入并开始生成。
- `turn/steer`：向活跃 turn 追加输入，不新建 turn。
- `turn/interrupt`：请求取消活跃 turn。

### Review

- `review/start`：运行 Codex reviewer，可针对未提交改动、base branch、commit 或自定义目标。

### Command / Process

- `command/exec`：在 server sandbox 下执行一个命令，不创建 thread/turn。
- `command/exec/write`：向运行中的 command session 写 stdin 或关闭 stdin。
- `command/exec/resize`：调整 PTY 大小。
- `command/exec/terminate`：停止 command session。
- `command/exec/outputDelta`：命令输出流通知。
- `process/spawn`：实验 API，在 Codex sandbox 外启动显式 process session。
- `process/writeStdin`、`process/resizePty`、`process/kill`：控制 `process/spawn` 启动的进程。
- `process/outputDelta`、`process/exited`：process 输出和退出通知。

### Models / Features

- `model/list`：列出可用模型、输入模态、reasoning effort、默认模型等。
- `modelProvider/capabilities/read`：读取 provider capability 边界，实验 API。
- `experimentalFeature/list`：列出功能开关、生命周期 stage 和启用状态。
- `experimentalFeature/enablement/set`：修改进程内 runtime feature enablement。
- `collaborationMode/list`：列出协作模式 preset，实验 API。

### Collaboration Mode 与 Goal

- `turn/start.collaborationMode` 接收完整协作模式对象。其 settings 使用 `model`、`reasoning_effort`、`developer_instructions` 的 snake_case 字段；客户端应把 preset 补齐后发送，而不是把“计划模式”拼入提示词。
- `thread/goal/get`、`thread/goal/set`、`thread/goal/clear` 读取、写入和清除持久化线程目标。Goal 属于 materialized thread，不应附着在 ephemeral thread。
- `thread/goal/updated` 与 `thread/goal/cleared` 是状态变化通知。客户端应把它们与当前 thread 关联，更新目标摘要；读取或通知失败不能让普通对话历史无法打开。

本项目的已有线程 Goal 走 provider 持有的连续 conversation owner：`thread/resume` 和当前 settings 应用完成后，在同一连接发送 `thread/goal/set`，不另起短连接，也不人为提交一条用户消息或 `turn/start`。随后自动 Goal turn 可连续到达；每个 `turn/completed` 只结束该 turn，目标终态、clear-drain、abort 或连接错误才结束 owner。

本项目通过 provider fork 接入这些 RPC；Renderer 只拿到 `default | plan` 和已脱敏的 Goal 摘要，完整协作 settings 仍留在 Main、provider 与 app-server 之间。

### Skills / Plugins / Apps

- `skills/list`：按 cwd 列出 skills，可 force reload。
- `skills/config/write`：按 path 启用或禁用 skill。
- `skills/changed`：本地 skill 文件变化通知。
- `marketplace/add`、`marketplace/upgrade`：管理 plugin marketplace。
- `plugin/list`、`plugin/read`、`plugin/install`、`plugin/uninstall`：查看和安装 plugin。
- `app/list`：列出 connectors/apps 及其可访问、启用状态。

### MCP / Config / FS

- `mcpServer/oauth/login`：启动 MCP server OAuth 登录。
- `mcpServerStatus/list`：列出 MCP servers、tools、resources 和 auth 状态。
- `mcpServer/resource/read`：读取 MCP resource。
- `mcpServer/tool/call`：调用 thread 配置中的 MCP tool。
- `config/read`：读取有效配置。
- `config/value/write`、`config/batchWrite`：写入用户配置。
- `config/mcpServer/reload`：重载 MCP server 配置。
- `configRequirements/read`：读取 requirements/MDM 约束。
- `fs/readFile`、`fs/writeFile`、`fs/createDirectory`、`fs/getMetadata`、`fs/readDirectory`、`fs/remove`、`fs/copy`、`fs/watch`、`fs/unwatch`：通过 v2 filesystem API 操作绝对路径。
- `fs/changed`：文件系统 watcher 通知。

### Account / Auth

- `account/read`：读取当前账号和 auth 状态。
- `account/login/start`：开始 API key、ChatGPT、device code 或实验 token 登录。
- `account/login/cancel`：取消登录。
- `account/logout`：退出。
- `account/updated`：认证状态变化通知。
- `account/rateLimits/read`、`account/rateLimits/updated`：读取和订阅 ChatGPT rate limit。
- `account/usage/read`：读取 ChatGPT token activity。
- `account/rateLimitResetCredit/consume`：消耗 earned reset credit。
- `account/sendAddCreditsNudgeEmail`：请求向 workspace owner 发送额度提醒。

## Models

`model/list` 用于在 UI 渲染模型选择器前获取模型目录和能力。常见字段：

- `id` / `model`：模型标识。
- `displayName`：UI 展示名。
- `hidden`：是否默认隐藏。
- `defaultReasoningEffort`：推荐默认 effort。
- `supportedReasoningEfforts`：支持的 effort 选项。
- `inputModalities`：支持输入类型，例如 `text`、`image`。
- `supportsPersonality`：是否支持 personality 指令。
- `isDefault`：是否推荐默认模型。
- `upgrade` / `upgradeInfo`：可用于客户端迁移提示。

兼容性提示：旧模型目录如果缺少 `inputModalities`，客户端可按支持 `text` 和 `image` 处理。

## Threads

### Start / Resume / Fork

`thread/start` 用于新会话。常见参数：

- `model`
- `cwd`
- `approvalPolicy`
- `sandbox` 或更明确的 permission profile / sandbox policy
- `personality`
- `serviceName`

`serviceName` 可用于把 thread-level metrics 标记到集成服务名。`thread.sessionId` 是当前 session tree root；root thread 使用自己的 thread id，forked thread 沿用 root 的 session id。

`thread/resume` 用于继续已保存 thread。仅 resume 本身不会更新 `updatedAt`；通常在下一次 `turn/start` 后更新。若 required MCP server 初始化失败，`thread/start` 和 `thread/resume` 会失败而不是静默降级。

`thread/fork` 会复制历史并生成新 thread。若已有用户可见 title，server 会在 `thread/list`、`thread/read`、`thread/resume` 等响应中填充 `thread.name`。

### Read / List

`thread/read` 用于只读查看，不加载到内存、不发 `thread/started`。`includeTurns` 控制是否返回 turn 历史。

`thread/turns/list` 用于分页读取 turn 历史。`itemsView` 可为：

- `notLoaded`
- `summary`
- `full`

`thread/list` 支持 cursor、limit、sort key、sort direction、provider、source kind、archived、cwd、searchTerm 等过滤。source kind 包括 `cli`、`vscode`、`exec`、`appServer`、`subAgent` 等。

### Archive / Delete / Unsubscribe

`thread/archive` 会移动持久化 JSONL log 到 archived sessions 目录，并尝试归档 spawned descendants。

`thread/delete` 永久删除 active/archived thread 和 spawned descendants。临时 root thread 不能删除。

`thread/unsubscribe` 取消当前连接订阅。若最后一个订阅者离开，server 会在无订阅且无活动一段时间后 unload thread，并发送 `thread/status/changed` 和 `thread/closed`。

### Shell / Compaction / Rollback

`thread/shellCommand` 是用户显式发起的 shell command，属于 thread，但不继承 thread sandbox policy，会以 full access 运行。客户端应只在用户主动触发时暴露。

`thread/compact/start` 返回很快，实际进度通过 `turn/*`、`item/*` 继续流式发送。

`thread/rollback` 会从内存上下文移除最后 N 个 turn，并在 rollout log 中记录 rollback marker。

## Turns

`turn/start` 的 `input` 是 item 列表。常见 input item：

- `{ "type": "text", "text": "..." }`
- `{ "type": "image", "url": "https://..." }`
- `{ "type": "localImage", "path": "/absolute/path.png" }`
- `{ "type": "skill", "name": "...", "path": "..." }`
- `{ "type": "mention", "name": "...", "path": "app://..." }`

每个 turn 可以覆盖配置，例如：

- `model`
- `effort`
- `personality`
- `cwd`
- `sandboxPolicy`
- `summary`
- `outputSchema`

部分设置会成为同一 thread 后续 turn 的默认值；`outputSchema` 只影响当前 turn。

### Sandbox Read Access

`sandboxPolicy` 支持显式读权限控制：

- `readOnly.access`
- `workspaceWrite.readOnlyAccess`

受限读取可以指定 `readableRoots`，也可以在 macOS 上通过 `includePlatformDefaults` 加入平台默认只读策略，以提升工具兼容性。

### Steering

`turn/steer` 用于给正在运行的 turn 追加用户输入。注意：

- 可以提供 `expectedTurnId`，并要求匹配当前活跃 turn。
- 没有活跃 turn 时请求失败。
- 不会触发新的 `turn/started`。
- 不接受 turn-level overrides，例如 `model`、`cwd`、`sandboxPolicy`、`outputSchema`。

### Interrupt

`turn/interrupt` 通过 `threadId` 和 `turnId` 请求取消。成功后，该 turn 最终状态为 `interrupted`。

## Review

`review/start` 运行 Codex reviewer，并流式发送 review item。target 类型包括：

- `uncommittedChanges`
- `baseBranch`
- `commit`
- `custom`

delivery：

- `inline`：默认，在已有 thread 上运行 review。
- `detached`：创建分离 review thread。

客户端需要处理 `enteredReviewMode` 和 `exitedReviewMode` item，用于渲染 review 开始和最终 review 文本。

## Process Execution

`process/*` 是实验性的显式进程控制 API，需要 `capabilities.experimentalApi = true`。它运行在 Codex sandbox 外，只应在客户端明确要提供本地 process control 时使用。

基本模型：

1. `process/spawn` 启动进程并指定 `processHandle`。
2. `process/outputDelta` 流式输出。
3. `process/writeStdin` 写入输入。
4. `process/resizePty` 调整 PTY。
5. `process/kill` 终止。
6. `process/exited` 通知退出。

## Command Execution

`command/exec` 在 server sandbox 下执行一个 argv 命令，不创建 thread。常见参数：

- `command`
- `cwd`
- `sandboxPolicy`
- `timeoutMs`
- `tty`
- `streamStdoutStderr`

注意：

- 空 command 数组会被拒绝。
- `sandboxPolicy` 可使用 `dangerFullAccess`、`readOnly`、`workspaceWrite`、`externalSandbox` 等形态。
- 若外部系统已经对 server process 做 sandbox，可使用 `externalSandbox`。
- 设置 `streamStdoutStderr` 后，可以通过 `command/exec/outputDelta` 获取流式输出。

## Filesystem

v2 filesystem API 只接受绝对路径。`fs/watch` 可用于 UI 状态失效和刷新；文件被 replace 或 rename 时，watcher 仍会发送对应 `fs/changed`。

常见 method：

- `fs/readFile`
- `fs/writeFile`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`
- `fs/watch`
- `fs/unwatch`
- `fs/changed`

## Events

事件是 server 主动发送给客户端的通知流。客户端在 start/resume thread 后，应持续读取 transport。

### Notification Opt-out

`initialize.params.capabilities.optOutNotificationMethods` 可精确禁用通知 method。

规则：

- 只做 exact match。
- 未知 method 会被忽略。
- 只影响通知，不影响 request、response 或 error。

### Turn Events

- `turn/started`：turn 开始，通常包含空 items 和 `inProgress` 状态。
- `turn/completed`：turn 完成、中断或失败。
- `turn/diff/updated`：当前 turn 聚合后的 unified diff。
- `turn/plan/updated`：agent 计划更新。
- `thread/tokenUsage/updated`：活跃 thread 的 token usage 更新。

`turn/diff/updated` 和 `turn/plan/updated` 不应被当作 item 状态权威来源；item 状态以 `item/*` 为准。

### Item Types

常见 `ThreadItem`：

- `userMessage`
- `agentMessage`
- `plan`
- `reasoning`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- `dynamicToolCall`
- `collabToolCall`
- `webSearch`
- `imageView`
- `enteredReviewMode`
- `exitedReviewMode`
- `contextCompaction`

每个 item 通常有：

- `item/started`
- `item/completed`

常见 delta：

- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `item/commandExecution/outputDelta`

官方文档指出旧的 `thread/compacted` 通知已被 `contextCompaction` item 取代。

## Errors

turn 失败时，server 会发送 error 事件，并让 turn 以 `failed` 状态完成。若上游 HTTP 状态可用，会出现在 `codexErrorInfo.httpStatusCode`。

常见 `codexErrorInfo`：

- `ContextWindowExceeded`
- `UsageLimitExceeded`
- `HttpConnectionFailed`
- `ResponseStreamConnectionFailed`
- `ResponseStreamDisconnected`
- `ResponseTooManyFailedAttempts`
- `BadRequest`
- `Unauthorized`
- `SandboxError`
- `InternalServerError`
- `Other`

## Approvals

根据用户 Codex 设置，命令执行和文件修改可能需要审批。App Server 会向客户端发送 server-initiated JSON-RPC request，客户端响应决策。

命令审批决策包括：

- `accept`
- `acceptForSession`
- `decline`
- `cancel`
- `acceptWithExecpolicyAmendment`

文件审批决策包括：

- `accept`
- `acceptForSession`
- `decline`
- `cancel`

请求中通常包含 `threadId` 和 `turnId`，客户端应据此把审批 UI 绑定到正确会话。

### Command Approval Flow

1. `item/started`：出现待审批的 `commandExecution` item。
2. `item/commandExecution/requestApproval`：server request，包含 `itemId`、`threadId`、`turnId`、reason、command、cwd、可用 decisions 等。
3. 客户端返回审批决策。
4. `serverRequest/resolved`：请求已被回答或清除。
5. `item/completed`：最终 `commandExecution` 状态为 completed、failed 或 declined。

当请求包含 `networkApprovalContext` 时，这是网络访问审批，不应简单当作 shell command 审批。客户端应按 host/protocol/port 渲染网络审批。

桌面实现应只把 host、protocol、reason、cwd 和白名单化的 action 名称发送到 renderer。
`acceptWithExecpolicyAmendment` 和 `applyNetworkPolicyAmendment` 的完整 policy 对象
必须保留在 Main；renderer 只能提交对应 intent，Main 再从本次请求的
`availableDecisions` 中取回并回传原对象。

`availableDecisions` 具有三态语义，客户端不能先统一转成空数组：

- 字段缺失或 `null`：按 App Server 的历史规则，从网络上下文、附加权限和 policy
  amendment 推导默认 decision；
- 显式非空数组：列表完全权威，只能展示和返回其中的 decision；
- 显式空数组：表示没有可用 decision，不能生成批准动作。

dasCowork 对显式空数组、未知 decision 或畸形 amendment 均 fail closed：不向 Renderer
发布审批卡，直接返回 `cancel`。`decline` 表示拒绝后继续 turn，`cancel` 表示拒绝并立即
中断 turn，两者不能合并为同一个响应。

### File Change Approval Flow

1. `item/started`：出现 `fileChange` item。
2. `item/fileChange/requestApproval`：包含 `itemId`、`threadId`、`turnId`、reason、grantRoot 等。
3. 客户端返回审批决策。
4. `serverRequest/resolved`。
5. `item/completed`：最终 `fileChange` 状态为 completed、failed 或 declined。

请求参数不带 patch；客户端如需展示 diff，应从同一个 `threadId`、`turnId`、`itemId`
的 fileChange item 通知中获取 `changes`，并在 item/turn 完成后清理本地缓存。

### Tool User Input

`tool/requestUserInput` 可让工具向用户提出 1 到 3 个短问题。`autoResolutionMs` 可指定自动解决超时；如果 pending request 在用户回答前被 turn 开始、完成或中断清理，server 也会发 `serverRequest/resolved`。

每个答案以 question id 为 key，wire 形态为 `string[]`。有 option 时应回传协议提供的
option label/value，不应以本地化后的描述文字替代。秘密答案只可保存在一次性 UI 表单状态
和 response 中，不应写入 pending 恢复快照或日志。

桌面端由 Main 保存自动处理的绝对 deadline：首次有效输入会 snooze 自动处理，刷新或切换会话不会重置倒计时；deadline 到期只返回空 answers 一次。

### Permission Request

`item/permissions/requestApproval` 请求的 response 为原始 permission profile 加 `turn` 或 `session` scope。renderer 只能显示安全编译后的网络、路径、glob、特殊目录和读/写/拒绝详情，并提交 scope intent；Main 必须从原始 request 重建 profile。空、未知或不能完整解释的 entry 必须 fail closed，不能显示批准动作。

### MCP Elicitation

`mcpServer/elicitation/request` 的 typed `form` 可安全映射为 string、number/integer、
boolean、单选 enum 和多选 enum。多选必须保持 `string[]`，number/boolean 保持原类型。
`mode: "url"` 仅允许 http/https 地址，客户端先通过外链策略打开，再由用户点击继续才可 accept。`mode: "openai/form"` 是任意 JSON：可安全完整编译时按普通表单处理；无法解释时必须 fail closed，并保留 decline 与 cancel 的不同语义。

### Dynamic Tools

`dynamicTools` 和 `item/tool/call` 是实验 API。动态 tool 名称和 namespace 需要遵循 Responses API 命名约束，并避开内置 Codex tool 的保留 namespace。

调用流程：

1. `item/started`，item 类型为 `dynamicToolCall`。
2. `item/tool/call` server request 发给客户端。
3. 客户端返回 content items。
4. `item/completed` 给出最终状态、contentItems、success 等。

### MCP Tool Approval

App/connector tool call 如有副作用，也可能触发审批。具有 destructive 注解的 tool 会强制审批；如果用户拒绝或取消，对应 `mcpToolCall` 会以 error 完成。

## Skills

调用 skill 的推荐方式：

1. 在 text input 里包含 `$<skill-name>`。
2. 同时添加 `skill` input item，带上 skill 名称和 `SKILL.md` 路径。

这样 server 可以直接注入完整 skill instructions，避免只依赖模型自行解析 marker。

`skills/list` 用于列出可用 skills，支持：

- `cwds`
- `forceReload`
- `perCwdExtraUserRoots`

server 会读取 `SKILL.json` 中的 `interface` 和 `dependencies`。当本地 skill 文件变化时，server 发送 `skills/changed`，客户端应重新调用 `skills/list`。

`skills/config/write` 可通过 path 启用或禁用 skill。

## Apps / Connectors

`app/list` 用于列出 apps/connectors。每个 app 可能包含：

- `id`
- `name`
- `description`
- `logoUrl`
- `installUrl`
- `isAccessible`
- `isEnabled`
- `branding`
- `appMetadata`
- `labels`

`isAccessible` 表示用户是否有权限访问；`isEnabled` 表示是否在本地 config 中启用。传入 `threadId` 时，app feature gating 会使用该 thread 的配置快照。

调用 app 的推荐方式：

1. 在 text input 里插入 `$<app-slug>`。
2. 添加 `mention` input item，`path` 为 `app://<id>`。

App 设置可以通过 `config/read`、`config/value/write`、`config/batchWrite` 读取和修改。常见配置位包括：

- `apps._default.enabled`
- `apps._default.destructive_enabled`
- `apps._default.open_world_enabled`
- `apps._default.approvals_reviewer`
- `apps._default.default_tools_approval_mode`
- per-app overrides
- per-tool overrides

## External Agent Config Import

`externalAgentConfig/detect` 用于发现可迁移的外部 agent 配置；`externalAgentConfig/import` 用于导入所选条目。

支持的 item type：

- `AGENTS_MD`
- `CONFIG`
- `SKILLS`
- `PLUGINS`
- `MCP_SERVER_CONFIG`
- `SUBAGENTS`
- `HOOKS`
- `COMMANDS`
- `SESSIONS`

导入会返回 `importId`，并通过：

- `externalAgentConfig/import/progress`
- `externalAgentConfig/import/completed`

报告同步和后台导入结果。检测逻辑会跳过已经完成的项目，例如已有非空 `AGENTS.md` 时不重复迁移。

## Auth Endpoints

Auth/account RPC 用于检查认证状态、登录、登出、读取 rate limits 和 usage，并处理 MCP OAuth 结果。

### Authentication Modes

官方文档列出的主要模式：

- API key：调用方提供 OpenAI API key，由 Codex 存储并使用。
- ChatGPT managed：Codex 管理 OAuth、持久化 token 并自动刷新。
- ChatGPT external tokens：实验模式，宿主应用自己管理 ChatGPT auth 生命周期，并在需要时向 app-server 提供 fresh token。
- Amazon Bedrock：`account/read` 会报告 Bedrock 账号和 credential source。

### Account API

- `account/read`：读取当前账号状态，可选强制刷新 token。
- `account/login/start`：启动登录。
- `account/login/completed`：登录完成通知。
- `account/login/cancel`：取消登录。
- `account/logout`：退出登录。
- `account/updated`：auth mode 变化通知。
- `account/chatgptAuthTokens/refresh`：server request，要求宿主刷新外部 ChatGPT token。
- `account/rateLimits/read`：读取 ChatGPT rate limits。
- `account/rateLimits/updated`：rate limit 变化通知。
- `account/usage/read`：读取 token activity summary 和 daily buckets。
- `account/rateLimitResetCredit/consume`：消耗 earned reset credit。
- `account/sendAddCreditsNudgeEmail`：请求发送 workspace owner 提醒邮件。

`requiresOpenaiAuth` 表示当前 provider 是否需要 OpenAI 认证。对 Bedrock 等 provider，可能为 `false`。

Rate limit 响应可能同时包含旧的单 bucket 视图 `rateLimits` 和多 bucket 视图 `rateLimitsByLimitId`。`resetsAt` 是 Unix seconds。

`account/usage/read` 需要 Codex services-backed authentication；API-key-only 和 Bedrock auth 不适用。

## 与本项目的落点

本项目当前架构里，desktop chat 链路大致是：

```text
renderer assistant-ui
  -> preload IPC
  -> Electron main CodexChatRuntimeService
  -> NativeCodexRunDriver
  -> @dascowork/codex-app-server-client
  -> codex-app-server --listen stdio://
  -> Codex runtime / provider / tools / approvals
```

因此：

- renderer 不应直接实现 App Server JSON-RPC。
- Main-owned native driver 与 AI-free client 是桌面协议适配边界；不得把 JSON-RPC 堆回 `CodexChatRuntimeService`。
- AI SDK provider fork 仅是独立兼容包，不在桌面生产依赖图中。
- 涉及 `thread/start`、`thread/resume`、`turn/start`、approval、sandbox、cwd、MCP、tools 或 elicitation 的改动，应先判断属于 app-server、AI-free client、main process 还是 renderer。
- 升级锁定的 Codex CLI 后，先重新生成 core 唯一的协议树，再运行 protocol
  contract、native boundary 和 real app-server contract smoke；后者只做
  `initialize`、`model/list` 与 ephemeral `thread/start`，不调用模型。

## 本地源码索引

- App Server README：`codex/codex-rs/app-server/README.md`
- 协议 RPC 基础结构：`codex/codex-rs/app-server-protocol/src/rpc.rs`
- 协议 common definitions：`codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- 生成 schema：`codex/codex-rs/app-server-protocol/schema/`
- 本项目架构说明：`docs/dasCowork-architecture.md`
