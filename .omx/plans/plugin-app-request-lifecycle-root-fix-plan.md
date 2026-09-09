# Plugin / Apps 请求生命周期根因修复计划

> 状态：Ready for implementation  
> 规划模式：`$plan` direct mode  
> 日期：2026-09-09  
> 适用范围：`desktop-app/` 与项目自有 `codex-app-server-client`；禁止修改 `codex/codex-rs/app-server/`

## 1. 结论与方案选择

本轮保留当前已经形成的正确方向：`AppServerClient` 不再给所有 JSON-RPC 请求套一个固定默认超时；只有明确传入 deadline 的调用才计时。`plugin/installed`、`app/installed` 和后续 `app/read` 都继续由 app-server 的真实完成、明确服务端错误、调用方取消或传输终止来结束，禁止恢复 30 秒、90 秒或 120 秒等经验值超时。

在此基础上，补齐当前方案缺少的两块结构能力：

1. **完整的请求生命周期所有权**：Renderer、Preload、Main、catalog client、host connection 和逻辑 transport 对“谁仍在等待、谁可以取消、谁负责释放”使用同一套语义。
2. **host-capability server request 的明确归属**：请求归属不能仅靠是否携带 `threadId` / `turnId` 推断。`currentTime/read` 虽然带 `threadId`，返回值仍由桌面 host 提供；auth refresh 和 attestation 则不带 thread target。三者都不能随意交给某个 Plugin Center catalog lease，也不能落入含糊的“无人接管”分支。

参考项目值得吸收的是取消、排队与可观测性的思想，不复制它对 `plugin/installed` 单独设置 30 秒且关闭重试的做法。当前项目已经有 Renderer/Main 两层 single-flight、分区缓存和 stale-while-revalidate，现阶段不引入一套新的全局优先级调度器；只有上线指标证明 host 连接存在饥饿后，再单独立项。

本计划是 [plugin-center-loading-performance-optimization-plan.md](./plugin-center-loading-performance-optimization-plan.md) 的请求生命周期补全计划，不回写或伪装该历史计划的完成状态。

## 2. 当前根因判断

### 已确认

- `AppServerClient` 的旧默认计时器会把仍在 app-server 内正常处理的 `plugin/installed` 强行判为失败；固定加大数字只会延后同一故障。
- 当前待提交修改已经把超时所有权改为显式调用方 deadline，并保留 transport 终止时清理所有 pending request 的能力：
  - `desktop-app/vendors/codex-app-server-client/src/client/app-server-client.ts:30`
  - `desktop-app/vendors/codex-app-server-client/src/client/app-server-client.ts:191`
  - `desktop-app/vendors/codex-app-server-client/src/client/app-server-client.ts:380`
- `TransportContext` 已有 `signal`，`CodexAppServerConnection.createTransport()` 也会向下传递，但 shared broker 分支没有消费该信号，导致取消链在真正的生产路径上断开：
  - `desktop-app/vendors/codex-app-server-client/src/client/app-server-connection.ts:40`
  - `desktop-app/vendors/codex-app-server-client/src/client/transport-persistent.ts:16`
  - `desktop-app/vendors/codex-app-server-client/src/client/transport-persistent.ts:71`
- Plugin Center renderer resource、preload IPC、main handler、catalog lease 目前都没有统一 request id / abort contract：
  - `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts:39`
  - `desktop-app/src/preload/pluginCenterBridge.ts:34`
  - `desktop-app/src/shared/pluginCenterApi.ts:7`
  - `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts:64`
  - `desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts:62`
- connection broker 目前只按 `threadId` / `turnId` 路由 server request；不带二者的请求直接返回 no-owner：
  - `desktop-app/vendors/codex-app-server-client/src/client/connection-broker.ts:480`
  - `desktop-app/vendors/codex-app-server-client/src/client/connection-broker.ts:696`
- `currentTime/read` 的真实协议参数是 `{ threadId: string }`，但当前 thread owner `NativeCodexRunDriver` 对它直接抛 unsupported；因此不能把“无 target”等同于“host capability”：
  - `desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/CurrentTimeReadParams.ts:5`
  - `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts:429`
- 生成的 `InitializeCapabilities` 已把 `requestAttestation` 定义为必填字段；手写 `CodexInitializeParams` 仍只声明 `experimentalApi`，存在协议类型漂移：
  - `desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/InitializeCapabilities.ts:9`
  - `desktop-app/vendors/codex-app-server-client/src/protocol/types.ts:111`

### 待测试验证，不提前当成既定根因

- `currentTime/read`、`account/chatgptAuthTokens/refresh` 或 `attestation/generate` 等 host-capability 反向请求是否实际与本次 `plugin/installed` / Apps 加载并发，并造成客户端表象上的长时间等待。
- 因此实现必须先构造“catalog request 处理中穿插 host server request”的协议测试，再决定支持哪些方法；不得靠猜测伪造 auth token、attestation 或服务端返回。

## 3. 需求摘要

### 必须实现

1. 保留“无通用默认请求超时”；显式 deadline 仍可用，且只影响明确选择它的调用。
2. Plugin / Apps 的加载不能因为客户端固定计时器报错；真实传输断开、服务端错误和主动取消仍需快速结束。
3. 取消必须有 request id、稳定错误类型和资源释放保证，不能仅在 UI 侧丢弃结果。
4. 共享缓存读取与独占读取使用不同取消语义，避免一个页面退出把其他等待者和预热任务一并掐断。
5. 显式登记的 host-capability method 由唯一 host owner 处理，即使协议参数包含 `threadId`；其余 thread / turn 请求继续按原有 owner 路由。
6. 不支持的 host 方法快速返回明确协议错误；不得用空值或伪造凭据“让流程继续”。
7. 日志提供 method、阶段、耗时、结果和 pending 数量，但禁止记录 params、cwd、thread 内容、access token、account 信息或 provider credentials。
8. 不修改 Codex app-server，不新增依赖，不把敏感配置暴露到 renderer。

### 明确不做

- 不复制参考项目 `plugin/installed = 30s, retry = false` 的调用参数。
- 不把 `waitForPendingRequests()` 的 shutdown drain 上限改造成业务请求超时；两者继续分离。
- 不把所有 Plugin Center 请求塞进新的全局 priority/concurrency scheduler。
- 不为通过测试而缩短假服务端延迟、吞掉非取消错误、把 timeout 改断言成成功，或在测试侧 mock 掉真实 IPC / broker 路径。
- 不在本任务中实现新的外部 ChatGPT token provider 或 attestation provider；没有真实依赖注入时必须明确拒绝。

## 4. 验收标准

1. fake app-server 在 120 秒后返回 `plugin/installed` 或 `app/installed` 时，请求能够成功完成，不出现客户端默认 `Request timed out`。
2. 显式传入 1 秒 deadline 的请求仍在约 1 秒后失败，并且 pending map 与 broker request mapping 各清理一次。
3. transport 退出或协议通道失效时，所有相关 pending 请求立即失败，逻辑 lease 被释放，没有悬挂 Promise。
4. Renderer 释放一个独占读取时，Main 能收到对应 request id 的 cancel，AbortSignal 到达 catalog lease / shared broker transport，且重复 cancel 幂等。
5. 共享缓存读取有两个调用方时，取消其中一个只结束该调用方的等待；底层共享请求继续供另一调用方完成并正确写入缓存。
6. 所有共享读取调用方都离开且该任务不是预热保留任务时，底层 owner controller 才取消 catalog lease；预热任务按明确策略继续完成并填充缓存。
7. Renderer 刷新、组件卸载、窗口销毁和 render process 退出都会清理 Main 的 request registry；没有 AbortController、监听器或 logical channel 泄漏。
8. `plugin/installed` pending 且同时存在一个活动 thread 时，收到真实形态的 `currentTime/read { threadId }` 后，host owner 返回 `{ currentTimeAt: <Unix 秒> }`，原 catalog 请求继续完成；原 thread approval / tool request 路由无回归。
9. 未配置真实 token provider 时，`account/chatgptAuthTokens/refresh` 返回明确 unsupported 错误；`requestAttestation` 能力显式为 `false`，不得制造占位 token 或证明材料。
10. `app/installed` 仅在 method unsupported 时走现有 `app/list` fallback；timeout、cancel、transport error 和普通 server error 都不得被误判为“不支持”。
11. lifecycle 日志能区分 `completed`、`cancelled`、`explicit-deadline`、`server-error`、`transport-terminated`，且日志脱敏测试证明不会输出请求 params 和凭据。
12. `git diff --name-only -- codex/codex-rs/app-server` 为空。

## 5. 实施步骤

### 第 1 步：先用回归测试锁定协议事实

先补测试，再改实现；测试必须复现客户端真实生命周期，不能通过减少延迟或改 mock 返回来绕过问题。

修改范围（明确区分现有文件与新增文件）：

- 现有：`desktop-app/vendors/codex-app-server-client/tests/app-server-client.test.ts`
- 现有：`desktop-app/vendors/codex-app-server-client/tests/host-lease-clients.test.ts`
- 新增：`desktop-app/vendors/codex-app-server-client/tests/connection-broker.test.ts`
- 新增：`desktop-app/vendors/codex-app-server-client/tests/transport-persistent.test.ts`
- 新增：`desktop-app/vendors/codex-app-server-client/tests/context-catalog-client.test.ts`
- 现有或按最近邻新增：`desktop-app/src/main/pluginCenter/*.test.ts`
- 现有或按最近邻新增：`desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts`

新增用例：

1. 保留当前“120 秒后成功”和“显式 1 秒 deadline 生效”两组 client 测试。
2. 构造共享物理连接上 `plugin/installed` pending、活动 thread 同时收到 `currentTime/read { threadId }` 的真实协议场景；验证 host-capability handler 返回 `{ currentTimeAt }` 后，catalog response 仍能路由回原调用方。
3. 单独构造不带 target 且未注册 host handler 的请求，验证它快速返回结构化 unsupported，不与 `currentTime/read` 的归属规则混为一谈。
4. AbortSignal 在连接前已经 aborted、请求 pending 中 aborted、response 与 abort 同时到达三种竞态，各自只 settle / release 一次。
5. 一名共享 waiter 取消、全部 waiter 取消、预热 owner 存在三种 cache 场景。
6. IPC request registry 在正常完成、主动取消、handler 抛错、窗口销毁四条路径都归零。
7. 验证 `app/installed` fallback 只识别 method-not-found / unsupported 语义，不把 cancel 或 transport error 当 fallback 条件。

停止条件：测试在旧实现上精确失败，且失败点位于生产客户端/IPC/broker，而不是测试替身本身。

### 第 2 步：固化 timeout 与 cancellation 的错误模型

修改范围：

- `desktop-app/vendors/codex-app-server-client/src/client/app-server-client.ts`
- `desktop-app/vendors/codex-app-server-client/src/errors.ts`
- `docs/ai-sdk-provider-codex-asp-api.md`

实现要求：

1. 保留当前 `requestTimeoutMs?: number` 作为显式 deadline；`undefined` / `0` 均不安装 timer，并在类型注释和 API 文档写清楚。
2. 新增稳定且可识别的 cancellation error code/class；cancel、explicit deadline、transport terminated、server error 不得共用一个模糊文本错误。
3. pending entry 记录 `method`、`startedAt` 和 settle 状态，只为生命周期管理与脱敏观测服务，不保存或输出 params。
4. timeout / abort / send failure / response 的清理走同一个幂等 settle 辅助函数，保证 timer、pending map 和 broker mapping 只清理一次。
5. `waitForPendingRequests()` 的默认参数必须直接使用独立的 `DEFAULT_PENDING_REQUEST_DRAIN_TIMEOUT_MS`，不得再从 `this.requestTimeoutMs` 派生；调用方仍可显式覆盖 drain 时间。代码注释必须明确它不是普通 RPC deadline。

### 第 3 步：修复 shared broker 对 AbortSignal 的断链

修改范围：

- `desktop-app/vendors/codex-app-server-client/src/client/transport-persistent.ts`
- `desktop-app/vendors/codex-app-server-client/src/client/connection-broker.ts`
- `desktop-app/vendors/codex-app-server-client/src/client/app-server-connection.ts`
- 对应 transport / broker tests

实现要求：

1. `PersistentTransport` 在 broker 路径与 pool 路径使用同一 signal 语义：
   - pre-aborted 时不创建逻辑 channel；
   - pending 中 abort 时向上发出稳定 cancellation、移除 signal listener、detach channel；
   - `disconnect()` 与 abort 竞态时只释放一次。
2. broker 的 `cancelRequest()` 除了删除 local-to-wire 映射，还要使 late response 成为可计数、可忽略的已取消响应，不能误投递到复用后的 request id。
3. `CodexAppServerConnection` 继续作为物理连接和逻辑 transport 的唯一入口，不另建 Plugin Center 专用 stdio 连接。
4. 扩展只读 diagnostics：至少包含 pending、active lease、cancelled、late response 计数；不包含 RPC params。

### 第 4 步：建立显式 host-capability server request owner

修改范围：

- `desktop-app/vendors/codex-app-server-client/src/client/connection-broker.ts`
- `desktop-app/vendors/codex-app-server-client/src/client/app-server-connection.ts`
- `desktop-app/src/main/codexRun/HostCodexConnection.ts`
- `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts`
- 相应 broker / host / native driver tests

推荐接口：

1. 在 `CodexAppServerConnection` / broker 上提供显式 `registerHostRequestHandler(method, handler)`，返回注销函数；每个 method 同时只能有一个 host owner。只有被显式登记的方法能够越过 thread / turn owner。
2. `routeServerRequest()` 的归属顺序固定为：
   - method 已显式登记为 host capability：交给 host owner，即使 params 中包含 `threadId`；
   - 其他 method 有 turn target：交给 turn owner；
   - 其他 method 有 thread target：交给 thread owner；
   - 其他无 target 请求：立即返回结构化 unsupported / method-not-found。
3. 对携带 `threadId` 的 host capability，broker / handler 必须确认该 thread 在当前 generation 中存在 owner；未知或过期 thread id 快速拒绝，不能借 host handler 绕过会话归属检查。
4. `HostCodexConnection` 在连接生命周期内注册 `currentTime/read`，读取真实 `{ threadId }` 参数并返回 `{ currentTimeAt: Math.floor(Date.now() / 1_000) }`。
5. 不修改生成文件 `protocol/app-server-protocol/InitializeCapabilities.ts`。把手写 `CodexInitializeParams.capabilities` 改为复用生成的 `InitializeCapabilities`，消除重复定义；`CANONICAL_CAPABILITIES` 使用 `satisfies InitializeCapabilities` 并显式设置 `{ experimentalApi: true, requestAttestation: false }`。
6. 只有未来接入真实 attestation provider 时才把 `requestAttestation` 改为 `true`。
7. `account/chatgptAuthTokens/refresh` 保持 fail-closed；只有存在经过 main process 注入、不会暴露给 renderer 的真实 token provider 时才允许注册 handler。
8. 移除或改写 `NativeCodexRunDriver` 中把已登记 host-capability method 当普通 thread method 处理的分支，避免出现两个 owner；thread approval、tool、MCP 和 elicitation 路由不变。

该步骤的通过标准不是“所有 host 请求都返回成功”，而是每个请求都有唯一、真实、可解释的 owner 或明确拒绝。

### 第 5 步：为 Plugin Center IPC 增加关联与取消协议

修改范围：

- `desktop-app/src/shared/pluginCenterApi.ts`
- `desktop-app/src/preload/pluginCenterBridge.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts`
- `desktop-app/src/main/index.ts`
- 对应 shared / preload / main tests

实现要求：

1. 新增仅供 IPC 使用的 envelope：`{ requestId, payload }`；`AbortSignal` 本身不跨 IPC 序列化。
2. 新增单向 cancel channel，例如 `codex:plugin-center:cancel-request`，payload 只包含 request id。
3. Preload 的公开方法使用第二参数 `options?: { signal?: AbortSignal }`：
   - 生成不可预测且只在当前 renderer 有效的 request id；
   - abort 时发送一次 cancel；
   - invoke settle 后移除 listener。
4. Main 使用 `webContents.id + requestId` 作为 registry key，创建内部 AbortController；拒绝同一 webContents 下重复的活动 request id。
5. 正常完成、异常、cancel、`webContents.destroyed` 和 `render-process-gone` 都在 `finally` / 统一清理入口注销 controller。
6. Main 把 `{ signal }` 作为内部执行上下文传给 PluginCenterService，业务 Zod DTO 继续只描述业务输入，不把控制字段混进 renderer 可见模型。
7. cancel 是幂等的；未知或已完成 request id 静默忽略并计数，不显示成用户错误。

### 第 6 步：按“共享读取 / 独占读取”传播取消

修改范围：

- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- `desktop-app/vendors/codex-app-server-client/src/context-catalog-client.ts`
- `desktop-app/src/main/codexRun/HostCodexConnection.ts`
- `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts`
- 相应 service / catalog / renderer tests

先定义两类语义，避免一刀切：

#### A. 共享缓存读取

适用于 snapshot、`plugin/list`、`plugin/installed`、Apps installed/list/read 聚合等已有 single-flight 读取。

- `SharedCacheEntry` 增加 owner AbortController、waiter 计数和是否由 prewarm 保留的标记。
- 每个 IPC 调用取消时只结束自己的等待并减少 waiter；只要还有 waiter 或 prewarm owner，底层 catalog 请求继续并正常填充缓存。
- waiter 归零且没有 prewarm owner 时，才 abort owner controller，并从 in-flight cache 中移除该 entry。
- 已取消 caller 不得收到后来完成的数据；其他 caller 和 cache 可以收到。

#### B. 独占读取

适用于未进入共享缓存的详情、内容读取等只服务一个调用方的请求。

- caller signal 直接传给 `ContextCatalogClient`。
- `CodexContextCatalogClientSettings.acquireClient` 从无参函数调整为接收只读 transport context，至少包含 `signal`；禁止把 signal 塞进 JSON-RPC params。
- `HostCodexConnection.acquire()` / `acquireLease()` 接收 context 并交给 `createTransport({ threadId, signal })`。
- abort 后 `withClient()` 的 `finally` 仍释放 lease，且 cancellation 不触发 persistent client 的“连接损坏”失效逻辑。

Renderer resource 的 `InFlightRequest` 增加 AbortController：generation 仍防止旧结果覆盖新状态；真正 `release()` 或新一代请求明确替代旧独占请求时才 abort。普通 tab 切换若仍有共享订阅或预热 owner，不应破坏共享加载。

用户触发的安装、卸载、启用、禁用等 mutation 一旦已经发往 app-server，不与页面卸载绑定取消；取消仅允许发生在 dispatch 之前。这样避免客户端显示取消、服务端却已经改变状态的歧义。

### 第 7 步：增加脱敏生命周期观测，不引入新调度器

修改范围：

- `desktop-app/vendors/codex-app-server-client/src/client/app-server-client.ts`
- `desktop-app/vendors/codex-app-server-client/src/client/connection-broker.ts`
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- 项目已有 main logger 接入点

实现要求：

1. 在 `AppServerClientSettings` 增加可选 `onRequestLifecycle(event)`；默认不做任何事，不改变库使用方行为。
2. event 只包含 method、阶段、durationMs、outcome、pendingCount、connection generation / channel 计数等安全元数据。
3. PluginCenterService 现有 section duration 日志继续保留，并与 client lifecycle event 通过 main 内部 request id 关联；request id 只用于本机诊断，不进入 app-server params。
4. intentional cancellation 记录为 info/debug，不弹“数据加载失败”；server error、transport error 仍按真实错误展示和记录，禁止统一吞掉。
5. 添加日志脱敏单测，使用包含 access token、cwd、插件配置的 fake params，断言输出中均不存在这些值。
6. 暂不实现参考项目的全局并发/优先级队列。上线后若数据证明某类长请求长期占用物理连接，再以观测数据单独设计 scheduler。

### 第 8 步：集成验证与文档收口

1. 更新相关 API / 架构说明，写清：默认无 deadline、共享读取取消规则、host request owner、错误分类和日志字段。
2. 运行第 6 节的所有验证命令；任何失败必须修生产实现，禁止修改测试来接受错误行为。
3. 检查没有 app-server 改动、没有新依赖、没有敏感字段进入 renderer 类型或日志。
4. 用真实账号做 Plugin 与 Apps 首次冷加载、刷新、快速切 tab、关闭窗口、断网重连五组人工验证；真实账号不可用时明确保留该验证缺口，不把 fake-server 结果写成线上完成。

## 6. 验证步骤

按依赖从小到大执行：

```bash
npm --prefix desktop-app/vendors/codex-app-server-client run lint
npm --prefix desktop-app/vendors/codex-app-server-client run typecheck
npm --prefix desktop-app/vendors/codex-app-server-client test
```

```bash
npm --prefix desktop-app run lint
npm --prefix desktop-app test -- pluginCenter
npm --prefix desktop-app test
```

```bash
npm --prefix desktop-app run test:e2e -- --reporter=line
```

额外静态检查：

```bash
git diff --check
git diff --name-only -- codex/codex-rs/app-server
```

验证证据至少记录：

- 120 秒延迟成功用例的完成时间与结果；
- 显式 deadline、主动取消、transport terminate 的不同错误类型；
- cancel 前后 pending request、logical channel、active lease 数量；
- 双 waiter 共享请求只发出一次 app-server RPC；
- interleaved `currentTime/read` 与 catalog response 的完整顺序；
- 日志脱敏断言；
- 完整 Desktop 测试与 E2E 结果。

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| abort 与 response 同时到达导致 double-settle | 泄漏、重复释放或错误回调 | 所有完成路径走单一幂等 settle；专门加入竞态测试 |
| 一个 caller 取消共享请求，误伤其他页面或预热 | 数据闪烁、重复 RPC | cache entry 持有 owner controller 和 waiter 引用计数；caller signal 不直接拥有共享 transport |
| 所有 waiter 离开后仍无限运行 | 后台资源占用 | 无 prewarm owner 时 abort owner controller；窗口销毁统一清理 |
| host handler 抢走普通 thread request | 审批或工具调用失效 | 只有显式登记的 method 才优先走 host owner；所有其他请求仍按 turn → thread 路由，并保留原审批回归测试 |
| 为解决 auth refresh 而泄漏或伪造凭据 | 严重安全问题 | 没有真实 main-side provider 就明确 unsupported；日志永不包含 params / token |
| 去掉默认超时后真实卡死不易发现 | 请求长时间 pending | 用可取消性、transport teardown 和生命周期观测解决；不恢复拍脑袋 deadline |
| 新 IPC envelope 破坏旧 preload/renderer 契约 | Plugin Center 整体不可用 | shared schema、preload、main 同批迁移；保留兼容 adapter 仅限一次版本迁移并在同计划删除 |
| cancellation 被 UI 当普通加载失败 | 误导用户 | 稳定 cancellation 类型；只对明确 cancellation 静默，其他错误原样显示 |
| 改动范围扩大成通用 scheduler 重构 | 风险与周期失控 | 本计划明确排除 scheduler；仅在指标证明 starvation 后另立计划 |

## 8. 实施顺序与提交边界

建议保持以下可独立审查的提交边界：

1. `test: lock plugin/apps request lifecycle regressions`
2. `fix: preserve caller-owned json-rpc deadlines`
3. `fix: propagate cancellation through shared transport`
4. `fix: route host-capability app-server requests`
5. `fix: add plugin-center ipc cancellation ownership`
6. `fix: make shared catalog cancellation reference-counted`
7. `chore: add sanitized request lifecycle diagnostics`
8. `docs: document plugin/apps request lifecycle`

每个提交完成后运行对应的最小测试；最终再运行完整 Desktop 测试和 E2E。若实施时发现 host-capability request 并未参与原故障，仍保留唯一 owner 和 fail-fast 这一协议修正，但在最终报告中把它标为独立可靠性修复，不虚构成已证明的超时根因。
