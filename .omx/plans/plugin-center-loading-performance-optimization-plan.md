# 插件中心加载性能优化计划

日期：2026-08-25  
模式：`$plan` direct  
状态：已实施，本地验证通过；真实账号复测待执行
范围：只优化 dasCowork 插件中心的数据加载与刷新路径，不修改 Codex app server，不改变现有插件中心产品功能。

## 1. 目标与已确认基线

真实运行日志已经确认：

- Renderer 从开始加载到收到数据耗时 `10,364ms`。
- Main 中 `plugin/list` 耗时 `10,141ms`，占总等待约 `97.8%`。
- Main 的 DTO 归一化与 schema 校验约 `84ms`。
- Main 完成到 Renderer 收到结果约 `135ms`。
- 单次目录包含 `2,917` 个插件。

因此本计划不以 React 微调或虚拟列表作为主方案，而是把 `plugin/list` 从“用户点击后的同步等待”改成“应用内共享、提前加载、长时间复用、过期后后台刷新”。

### 目标结果

1. 应用进入可交互状态后，在后台预热插件目录，不能阻塞聊天、历史列表或首屏交互。
2. 同一 cwd 的插件目录成功加载后保持新鲜 6 小时；重新打开插件中心不再调用 `plugin/list`。
3. 目录过期时先显示旧数据，再在后台刷新；刷新期间不得退回整页 Loading。
4. 已安装/启用状态使用独立的 `plugin/installed` 查询，保持新鲜 1 分钟。
5. 安装、卸载和插件启停只刷新已安装状态，不再强制刷新 2,917 条目录。
6. 技能、应用、MCP 管理数据按当前 tab 加载，不能因为一个慢分区卡住整个管理页。
7. 保留当前性能日志，并补充缓存命中、合并请求和真正可见时间，保证优化结果可复测。

## 2. 需求摘要

- 只优化桌面端 Renderer、Preload、Main 和 provider fork；禁止修改 `codex/codex-rs/app-server/`。
- 默认插件浏览继续只依赖目录摘要，不恢复全量 `plugin/read`；现有轻路径位于 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:629-633`。
- 预热必须是可取消的后台任务，不能成为聊天首屏或首条消息的前置条件。
- 有成功数据后始终旧数据优先；自动刷新、手动刷新和 mutation 回读均不得清空可见列表。
- 目录发现信息与安装/启用状态分离缓存，mutation 只失效受影响的数据。
- 不新增依赖，不接参考项目私有 `/ps/plugin-categories/*` API，不改变现有安全 IPC 边界。
- 交付必须包含单元、IPC/preload、Renderer、Electron E2E 和真实 2,917 条目录复测证据。

## 3. 参考项目结论及本项目采用方式

### 3.1 参考项目的关键行为

- 插件目录使用共享 query，query key 包含 host、roots 和 marketplace 类型；`plugin/list` 成功结果 `staleTime` 为 6 小时，`gcTime` 为 5 分钟：`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:234572-234622`。
- 已安装插件使用独立的 `plugin/installed` query，`staleTime` 为 1 分钟：同文件 `:234849-234885`。
- 首页输入区的插件控件复用同一份插件目录 query，因此用户进入插件中心前通常已经完成加载：`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugin-picker-menu-content--tqejYcN.js:34-48`、`composer-work-home-plugins-control.electron-CPZfQ2Sg.js:331-354`。
- 插件详情由详情页按需调用 `plugin/read`，不作为插件浏览首屏前置条件：`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugin-detail-page-D-RIq6rf.js:386-394`。
- 参考项目的分类分页依赖专有 `/ps/plugin-categories/*` 后端：`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/category-plugins-query-DHZr-B1h.js:53-110`。本项目没有该后端，本计划不复制该路径。

### 3.2 本项目采用的等价方案

不新增 TanStack Query 等依赖。使用现有 React 能力和小型外部 store 实现参考项目的必要语义：

```text
App 常驻预热订阅
        │
        ▼
PluginCenterDataResource（Renderer）
  ├─ catalog：6 小时新鲜期 / 5 分钟无订阅回收 / single-flight
  ├─ installed：1 分钟新鲜期 / single-flight
  └─ skills、apps、mcp：按当前 tab 加载，旧数据优先
        │
        ▼
Preload 固定白名单 API
        │
        ▼
PluginCenterService（Main）
  ├─ catalog promise/result cache + 同请求合并
  ├─ installed 轻量读取与写后验证
  └─ 只返回安全 DTO，不向 Renderer 暴露原始 config/provider 数据
        │
        ▼
现有 provider fork -> Codex app-server RPC
```

Renderer store负责页面响应速度、订阅和后台刷新；Main cache负责避免不同 IPC 调用、安装定位和并发请求重复触发 `plugin/list`。两层职责不同，不互相替代。

## 4. 当前实现需要替换的行为

- 插件页面只有用户点击后才挂载，因此当前没有目录预热：`desktop-app/src/renderer/src/App.tsx:765-785`。
- Renderer cache 只有 60 秒，并且 cache key 包含 threadId；切换会话会让与 thread 无关的插件目录失效：`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:97-156`。
- 当前插件页在无响应时只显示整页 Loading：同文件 `:744-758`。
- manage 页面一次请求 `plugins + skills + apps + mcp`，最慢分区会卡住所有 tab：同文件 `:286-292`、`desktop-app/src/main/pluginCenter/PluginCenterService.ts:117-172`。
- 安装、卸载、插件启停以及其他写操作通过 `successWithSnapshot(...forceRefresh: true)` 做写后验证，会再次触发完整 snapshot：`desktop-app/src/main/pluginCenter/PluginCenterService.ts:272-317,469-494`。
- 添加市场成功后也同步等待一次强制目录刷新：同文件 `:439-465`。
- provider 已经具备 `plugin/installed` 管理读取能力，可以直接复用，无需修改 app-server：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts:291-302`。

## 5. 缓存与刷新规则

| 数据 | cache key | 新鲜期 | 过期行为 | 强制失效来源 |
| --- | --- | ---: | --- | --- |
| 插件目录 catalog | API 实例 + 规范化 cwd + marketplace kinds | 6 小时 | 立即返回旧数据，后台只刷新一次 | 用户点刷新、添加市场成功、市场配置变化 |
| 已安装插件 installed | API 实例 + 规范化 cwd | 1 分钟 | 立即返回旧状态，后台刷新 | 安装、卸载、插件启停 |
| 技能 | API 实例 + 规范化 cwd | 1 分钟 | 当前 tab 保留旧列表并刷新 | 技能启停、用户刷新 |
| 应用 | API 实例 + 规范化 cwd | 1 分钟 | 当前 tab 保留旧列表并刷新 | 应用启停、用户刷新 |
| MCP | API 实例 + 规范化 cwd + threadId（仅当状态确实依赖 thread） | 30 秒 | 当前 tab 保留旧列表并刷新 | MCP 新增、编辑、删除、启停 |

规则说明：

- 插件目录 cache key 不得包含 threadId。当前 `plugin/list` 只使用 cwd，thread 切换不应触发 10 秒冷请求。
- 同一 key 同时只能存在一个进行中的 Promise。App 预热、插件页面挂载和刷新同时发生时必须共享该 Promise。
- 5 分钟回收只针对已经没有订阅者的旧 cwd。App 当前 cwd 的常驻预热订阅应保持资源存活。
- 目录刷新失败时保留上一次成功数据和时间戳，并显示非阻塞错误；只有从未成功加载过时才显示首屏 Loading/错误空态。
- 目录中的 `installed/enabled` 只作为已安装查询尚未返回时的临时回退；一旦 `plugin/installed` 返回，以独立状态为准。
- 已安装查询中存在但目录中不存在的插件必须追加为“已安装但当前市场不可用”的项目，不能从管理页消失。
- 不做跨应用重启的磁盘持久化。该行为与参考项目的内存 query cache 一致；若未来要求冷启动后立即可见，应另立磁盘缓存安全评审。

## 6. 可测试验收标准

### 6.1 性能

1. 使用会延迟 5 秒响应 `plugin/list` 的 E2E fixture：预热完成后连续打开插件中心 10 次，`renderer-start -> renderer-content-ready` 的 p95 小于 `300ms`，且 RPC 日志中只有 1 次 `plugin/list`。
2. 预热仍在进行时立即打开插件中心，App 预热和页面读取合计只能发出 1 次 `plugin/list`；页面最终使用同一结果完成渲染。
3. 在 fake clock 中推进超过 6 小时后打开页面，旧列表在 `100ms` 内保持可见，并且后台只发出 1 次刷新请求。
4. 同一 cwd 下切换 threadId 不新增 `plugin/list`；切换到不同 cwd 恰好新增 1 次请求。
5. 安装、卸载、插件启停完成后，RPC 序列中不得出现 `plugin/list`；只允许对应 mutation RPC、必要的 config 写入和 `plugin/installed` 写后回读。
6. 真实环境复测时，预热后的 `renderer-response` p95 小于 `250ms`；如果首次打开发生在预热完成前，日志必须显示 `inflight-joined`，不能出现第二次目录请求。

### 6.2 正确性与体验

1. 目录成功缓存后，即使后台刷新失败，2,917 个插件仍可搜索、分类和安装，不退回空页面。
2. 安装/卸载/启停后，已安装横栏、浏览卡片和管理页状态全部更新；重新打开页面状态一致。
3. 添加市场成功后保留当前列表，显示刷新状态；新市场数据返回后原地更新，失败时保留旧列表并给出错误。
4. 管理页打开插件、技能、应用、MCP 任一 tab 时，只请求该 tab 必需的数据；不能再默认扇出全部四个分区。
5. 首次无缓存加载可以显示 skeleton；有缓存时只显示局部刷新指示，不允许整页 `LoadingState` 覆盖已有内容。
6. 所有 IPC 输入输出继续经过共享 Zod schema 校验，Renderer 不获得原始 app-server payload、cwd 内容、threadId 内容、config 或敏感字段。
7. `git diff --name-only` 不包含 `codex/codex-rs/app-server/`，且不新增 npm 依赖。

## 7. 实施步骤

### 步骤 1：先锁定现有行为和性能回归测试

涉及文件：

- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`
- `desktop-app/src/main/pluginCenter/PluginCenterService.test.ts`
- `desktop-app/tests/e2e/plugin-center.e2e.ts`
- `desktop-app/tests/e2e/support/plugin-center-app-server.mjs`

实施内容：

1. 给 E2E app-server fixture 增加可配置的 `plugin/list` 延迟、调用次数和 `plugin/installed` 状态变更，不使用真实网络。
2. 新增回归测试，先证明当前页面需要等待延迟目录、60 秒缓存过期或 context key 变化后重开会重复请求、mutation 会强制调用 `plugin/list`；这些测试在改造前应失败或明确标注为目标测试。
3. 为 2,917 条插件构造轻量 fixture，记录归一化和 Renderer commit 的耗时，防止优化后引入明显 CPU/内存回退。
4. 保留现有“默认浏览不调用 plugin/read”的断言：当前覆盖位于 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx:395-423` 和 `desktop-app/tests/e2e/plugin-center.e2e.ts:48-65`。

完成条件：新增测试能够分别识别 cache hit、stale refresh、in-flight 合并、cwd/thread key 行为和 mutation RPC 序列。

### 步骤 2：扩展安全的已安装状态与失效契约

涉及文件：

- `desktop-app/src/shared/pluginCenterApi.ts`
- `desktop-app/src/shared/pluginCenterApi.test.ts`
- `desktop-app/src/preload/pluginCenterBridge.ts`
- `desktop-app/src/preload/pluginCenterBridge.test.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.test.ts`

实施内容：

1. 新增固定白名单查询 `getInstalledPlugins`，输入只允许 `version/cwd`，输出使用安全的 `PluginCenterPlugin[]` 或等价的最小安装状态 DTO；禁止返回原始 marketplace/config 数据。
2. 为 mutation result 增加明确的 `changedSections`，取值限定为 `catalog/installed/skills/apps/mcp`，由 Main 告诉 Renderer 应刷新哪一份资源。
3. 插件安装、卸载和启停返回 `changedSections: ['installed']`；添加市场返回 `['catalog','installed']`；技能、应用、MCP 写操作分别返回自己的 section。
4. 对所有新增 request/result 做双边 schema 解析，并沿用当前固定 IPC handler 模式：`desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts:38-120`、`desktop-app/src/preload/pluginCenterBridge.ts:22-102`。

完成条件：非法字段在进入 service 前被拒绝；包含路径、原始配置或密钥的伪造 service 返回值在 IPC 返回前被拒绝。

### 步骤 3：Main 建立目录缓存、同请求合并和轻量写后验证

涉及文件：

- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- `desktop-app/src/main/pluginCenter/PluginCenterService.test.ts`
- `desktop-app/src/main/index.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts`（优先只复用现有方法；只有类型或返回裁剪不足时才改）
- `desktop-app/vendors/ai-sdk-provider-codex-asp/tests/context-catalog-client.test.ts`（仅在 provider 发生改动时）

实施内容：

1. 在 `PluginCenterService` 增加按规范化 cwd/marketplace kinds 分组的 catalog cache，保存最近成功结果、更新时间和进行中的 Promise；最大保留 3 个 cwd，避免 2,917 条目录无限增长。
2. 普通读取在 6 小时内直接返回缓存；相同 key 的并发读取加入现有 Promise；`forceRefresh` 只创建一个新的刷新 Promise。
3. 缓存原始目录只留在 Main，额外建立 `pluginId -> locator` 索引，供 `findPluginLocator` 使用，避免点击安装时再次调用 `plugin/list`。当前重复读取入口位于 `desktop-app/src/main/pluginCenter/PluginCenterService.ts:497-526`。
4. 增加 `getInstalledPlugins`，调用 provider 已有的 `listInstalledPluginsForManagement()`，归一化并只保留安全 DTO；缓存 1 分钟，并支持强制写后回读。
5. 将 `successWithSnapshot()` 拆成按 section 的写后验证：
   - 插件安装/卸载/启停使用 `plugin/installed` 验证。
   - 技能只强制读取 skills。
   - 应用只强制读取 apps。
   - MCP 只强制读取 MCP snapshot。
   - 结果不再携带全量 snapshot，改为 `changedSections` 和必要的轻量 readback。
6. 添加市场成功后立即失效 catalog cache，但不在 mutation IPC 内同步等待新的 10 秒目录；由 Renderer 保留旧数据并启动后台强制刷新。
7. 延续现有 `[plugin-center:perf:*]` 日志，增加 `cacheStatus: miss|fresh|stale|inflight-joined`、cache key 的非敏感摘要、刷新原因和 RPC 次数；不得记录 cwd/threadId 的实际值。现有计时入口位于 `desktop-app/src/main/pluginCenter/PluginCenterService.ts:117-269`。

完成条件：Main 单元测试证明同 key 并发只调用一次 provider，插件 mutation 不调用 `listPluginCatalog`，添加市场不会等待刷新目录。

### 步骤 4：Renderer 建立共享数据资源，替换页面私有 60 秒 cache

新增/涉及文件：

- 新增 `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts`
- 新增 `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`

实施内容：

1. 使用 `useSyncExternalStore` 建立模块级资源，不新增状态管理依赖；资源状态至少包含 `data/error/status/isRefreshing/updatedAt/inFlight/subscriberCount`。
2. 分离 catalog 和 installed 两个 query：catalog 6 小时，installed 1 分钟；提供 `subscribe/getSnapshot/prefetch/refresh/invalidate/release` 固定方法。
3. cache key 使用稳定 API 身份和规范化 cwd；catalog key 明确排除 threadId。若未来引入 remote host 或 marketplaceKinds，再把它们加入 key，不按页面 surface 建重复目录缓存。
4. 实现 stale-while-revalidate：有旧数据时 `refresh()` 只设置 `isRefreshing`，不清空 `data`；失败时保留数据并记录 error。
5. 实现 single-flight：App 预热、页面读取和手动刷新对同一 key 复用 Promise；请求完成或失败后必须清理 in-flight 状态。
6. 无订阅资源 5 分钟后回收；最多保留 3 个 cwd；测试使用 fake timers，不依赖真实等待。
7. 删除 `PluginCenterPage.tsx:97-156` 的 WeakMap 60 秒 snapshot cache，避免两套行为继续并存。
8. 将目录数据与 installed 数据合并：目录提供展示/分类信息，installed 覆盖 `installed/enabled`；installed-only 项追加到管理列表。

完成条件：资源单元测试覆盖 fresh hit、stale hit、force refresh、失败保旧、in-flight 合并、GC、cwd/thread key、installed-only 合并。

### 步骤 5：在 App 常驻层预热，不阻塞聊天首屏

涉及文件：

- `desktop-app/src/renderer/src/App.tsx`
- `desktop-app/src/renderer/src/App.test.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/index.ts`

实施内容：

1. 将当前内联计算的插件中心 cwd 提升为稳定变量，App 和 PluginCenterPage 使用完全相同的规范化结果：当前使用点位于 `desktop-app/src/renderer/src/App.tsx:776-784`。
2. 在 App 常驻生命周期订阅当前 cwd 的 catalog 和 installed 资源；聊天 surface 可见时也保持订阅，模拟参考项目首页插件控件复用 query 的行为。
3. 预热安排在首个 Renderer commit 后的空闲任务中执行；若环境没有 `requestIdleCallback`，使用可取消的短延迟 fallback。预热失败不得改变聊天 surface、弹 toast 或阻断其他启动任务。
4. 用户在预热开始前点击插件入口时，页面立即启动同一资源；用户在预热进行中点击时，页面加入同一 Promise。
5. cwd 变化时订阅新 key；旧 key 按 5 分钟 GC 回收。threadId 单独变化不触发 catalog 预热。

完成条件：App 测试证明启动不等待 catalog Promise，插件页与预热共享一次请求，预热失败不影响聊天页面渲染。

### 步骤 6：页面改成旧数据优先，并按 tab 加载管理数据

涉及文件：

- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`

实施内容：

1. 默认插件浏览页直接消费共享 catalog + installed 资源；只有两者均无可用数据时显示首次 skeleton。
2. 手动刷新保留当前卡片，刷新按钮显示进行中；成功原地替换，失败在页面顶部显示非阻塞错误。
3. 将 `snapshotSectionsForSurface()` 从“manage 全分区”改为当前 tab 最小集合：
   - browse/plugins：catalog + installed。
   - manage/plugins：installed，按需从 catalog 补展示信息。
   - browse/skills、manage/skills：skills；需要插件详情时只读已安装插件并缓存，不扫描全部 2,917 个插件。
   - manage/apps：apps。
   - manage/mcp：mcp。
4. 各 tab 拥有独立 loading/error/refreshing 状态；切换 tab 不清空已经加载过的数据。
5. `applyMutationResult()` 根据 `changedSections` 精准失效；删除当前“没有 snapshot 就 `refresh(true)` 整页”的兜底路径：现有逻辑位于 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:600-618`。
6. 安装、卸载、启停优先更新 installed overlay，再用 `plugin/installed` 回读纠正；catalog 只有在添加市场或手动刷新时失效。
7. 目录刷新期间对搜索和分类继续使用旧数组，避免 2,917 条卡片反复归零/重建。

完成条件：Renderer 测试证明缓存数据始终可见、tab 切换不扇出无关请求、插件 mutation 不触发 catalog refresh。

### 步骤 7：补齐可观测性和真实性能 E2E

涉及文件：

- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- `desktop-app/tests/e2e/plugin-center.e2e.ts`
- 可选新增 `desktop-app/tests/e2e/plugin-center-performance.e2e.ts`

实施内容：

1. Renderer 日志补充：`prefetch-start/complete`、`cache-hit-fresh`、`cache-hit-stale`、`inflight-joined`、`renderer-content-ready`。
2. `renderer-content-ready` 必须在 React 已提交内容后记录，使指标覆盖 API 等待、schema 解析和实际页面 commit，而不只是在 `setState` 前记录。
3. Main 日志保留各 section 耗时，并加入 catalog cache 状态、provider 调用次数和 mutation readback 类型。
4. E2E fixture 支持延迟目录，并断言 RPC 次数、打开耗时、刷新时旧内容可见、mutation 后无 `plugin/list`。
5. 将真实性能复测方法写入测试注释或项目文档：应用启动后等待 `prefetch-complete`，连续打开 10 次，计算 `renderer-content-ready - renderer-start` 的 p95。

完成条件：日志能区分“真正冷请求”“复用预热 Promise”“新鲜缓存”“旧数据后台刷新”四种路径，并且不包含路径、threadId、配置或密钥。

### 步骤 8：分层验证与完成检查

按顺序执行：

1. Provider（仅在发生改动时）：
   - `npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint`
   - `npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck`
   - `npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run test`
2. Desktop 定向测试：
   - `npm --prefix desktop-app run test:unit -- src/main/pluginCenter/PluginCenterService.test.ts src/main/pluginCenter/registerPluginCenterIpc.test.ts src/preload/pluginCenterBridge.test.ts src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`
3. Desktop 全量静态验证：
   - `npm --prefix desktop-app run lint`
   - `npm --prefix desktop-app run typecheck`
   - `npm --prefix desktop-app test`
4. Electron E2E：
   - `npm --prefix desktop-app run test:e2e -- tests/e2e/plugin-center.e2e.ts --reporter=line`
   - 若单独新增性能文件，再运行 `tests/e2e/plugin-center-performance.e2e.ts --workers=1 --reporter=line`。
5. 真实环境复测：使用当前 2,917 条插件账号，收集 1 次冷预热和 10 次预热后打开日志，核对第 6 节全部指标。
6. 边界检查：`git diff --name-only` 不得出现 `codex/codex-rs/app-server/`；`package.json` 不得新增依赖。

停止条件：所有功能测试通过，warm-open p95 达标，同一 key 的 `plugin/list` 次数达标，mutation 不再刷新完整目录，且无 app-server 改动。

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| 6 小时缓存让新上架插件不能立即出现 | 目录新鲜度下降 | 用户刷新和添加市场强制刷新；过期后旧数据优先、后台更新 |
| catalog 与 installed 使用不同响应，ID 可能不一致 | 安装状态显示错误 | 统一使用 app-server plugin id；增加 marketplace/name fallback 仅用于诊断，不静默合并冲突项 |
| 预热与聊天启动争用 app-server | 聊天首屏或首条消息变慢 | 首次 commit 后空闲调度；不 await；使用 shared connection 和 single-flight；E2E 增加“聊天不被预热阻塞”断言 |
| 2,917 条数据在 Main/Renderer 双层缓存占用内存 | 长时间运行内存上涨 | 最多 3 个 cwd；5 分钟无订阅回收；复用对象引用，不保存重复 raw payload 到 Renderer |
| stale refresh 在 mutation 后覆盖新状态 | UI 状态回退 | catalog 只负责展示字段，installed overlay 为状态权威；使用 revision/requestId 丢弃旧响应 |
| 添加市场后后台刷新失败 | 用户误以为添加失败 | mutation 成功与目录刷新状态分开显示；保留旧目录并允许重试 |
| 管理 tab 拆分后出现短暂数据不一致 | 数量或归属晚更新 | 每个 section 有独立更新时间；mutation 精准失效；不把未加载计数显示成 0 |
| 模仿参考项目时误接私有分类 API | 架构越界且不可部署 | 明确不调用 `/ps/plugin-categories/*`；继续使用 app-server 目录数据做本地分类 |

## 9. 交付清单

- [x] 共享 catalog/installed Renderer resource 与单元测试。
- [x] App 常驻预热，不阻塞聊天首屏。
- [x] Main catalog cache、single-flight、locator 索引与 installed 轻量读回。
- [x] 新增安全 IPC/preload installed 查询及 mutation 精准失效字段。
- [x] 插件页 stale-while-revalidate，移除 60 秒页面私有 cache。
- [x] 管理页按 tab 加载，不再全量扇出。
- [x] 插件 mutation 不再触发 `plugin/list`。
- [x] 缓存/预热/真实 commit 性能日志。
- [x] 延迟 RPC 与 2,917 条目录 E2E 验证。
- [ ] 真实环境 2,917 条插件账号复测。
- [x] 优化范围的 lint、typecheck、unit、E2E 通过，且不修改 app-server、不新增依赖。

## 10. 本地验证记录

- `npm --prefix desktop-app run typecheck:web`：通过。
- `npm --prefix desktop-app run typecheck:node`：通过。
- `npm exec -- vitest run src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx src/renderer/src/App.test.tsx src/main/pluginCenter/PluginCenterService.test.ts src/main/pluginCenter/registerPluginCenterIpc.test.ts src/preload/pluginCenterBridge.test.ts src/shared/pluginCenterApi.test.ts`（在 `desktop-app/` 下执行）：7 个文件、273 个测试通过。
- `npm --prefix desktop-app run test:e2e -- tests/e2e/plugin-center.e2e.ts --reporter=line`：8 个 E2E 测试通过，包含 5 秒延迟 `plugin/list`、2,917 条目录、10 次预热后打开 p95 `<300ms`、in-flight 合并、mutation 后不新增 `plugin/list`。
- `npm --prefix desktop-app run lint`：退出码 0；仓库仍有既有 Prettier warning，不影响本次通过状态。
- Desktop 全量 Vitest：199/200 个文件、1,943/1,944 个测试通过；无关的 `reviewFileContent` 用例在全量并发下超过 5 秒，单文件复跑 3/3 通过。
- Provider 全量 Vitest：26/27 个文件、306/307 个测试通过；无关的 Goal mutation 用例稳定超过 5 秒；本次涉及的 `context-catalog-client` 复跑 23/23 通过。
- `git diff --name-only` 与 `git diff --cached --name-only` 均未包含 `codex/codex-rs/app-server/`、`package.json`、lockfile。
