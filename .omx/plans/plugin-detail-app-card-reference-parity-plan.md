# 插件详情页“应用”卡片参考交互复刻计划（含能力降级说明）

日期：2026-08-27  
模式：`$plan` direct；本轮只做只读分析并写计划，不修改业务源码  
参考版本：`reference-projects/codex-electron-26.818.21641-beautified`  
目标：在不修改 Codex app server、不绕过 app-server 直连私有连接器接口的前提下，完整复刻公共协议能够支撑的应用卡片 UI 与交互；对连接账户身份、原生 OAuth/ToS 和远程多账户开关等缺少公共数据源的能力，逐项标记原因、可见降级和解除条件。

## 1. 结论

参考项目的应用卡片右侧不是固定的开关，而是由“插件是否安装、应用是否已连接、是否启用、配置是否可编辑、是否正在连接”共同决定的状态机。右侧状态机、整卡工具弹窗、工具分组折叠、限制提示和 Try now 均可基于现有公共协议实现；连接账户邮箱、原生连接器授权流程和 Add account 的远程开放条件无法在当前边界内精确复刻。

推荐实现方式：保留现有 `app/list + config/batchWrite + 安全外链` 链路，新增一个按应用懒加载工具摘要的固定 IPC；Renderer 只负责显示和编排，Main 负责安全投影、限制来源和设置 URL，provider 继续只通过 Codex app server 调用 `app/read`、`config/read`。工具数据在点击卡片时加载，不随插件详情一次性读取所有应用工具。

本计划会取代旧计划中“应用工具、Try in Chat 和完整高级动作矩阵不在本轮”的边界；旧计划的原始限制见 `.omx/plans/plugin-center-plugin-detail-page-parity-plan.md:85-92`。

## 2. 参考项目右侧有哪些按钮

参考详情页给应用行固定传入 `manageAction="menu"`，并根据插件安装状态决定是否显示安装后的动作：`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugin-detail-page-D-RIq6rf.js:5210-5256`。真正的右侧控件状态机位于 `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:764447-764758`。

| 条件 | 右侧控件 | 实际功能 |
| --- | --- | --- |
| 插件未安装 | 无控件 | 只展示应用信息；安装插件后才出现应用动作。 |
| 应用被管理员禁用且不可访问 | 静态锁定状态图标 | 不是按钮；显示禁用原因，不能触发连接或配置写入。参考：`plugin-detail-page-D-RIq6rf.js:5220-5241`、`app-initial-DOX-K1rC.js:764577-764582`。 |
| 插件已安装，应用可访问且有效启用 | `● Connected ▼` 下拉按钮 | 绿色状态点；连接/配置更新期间禁用。参考：`app-initial-DOX-K1rC.js:764592-764620`。 |
| 插件已安装，应用可访问但被用户配置禁用 | `Connect` 描边按钮 | 调用 `setAppEnabled({enabled:true})`，成功回读后进入 Connected 状态，不额外打开浏览器。参考：`app-initial-DOX-K1rC.js:764673-764690`。 |
| 插件已安装，应用不可访问 | `Connect` 描边按钮 | 打开连接流程；如果存在可编辑的禁用配置，先启用，成功后再连接。连接中显示 spinner。参考：`app-initial-DOX-K1rC.js:764713-764758`。 |

`Connected` 菜单包含三个命令：

- `Reconnect`：重新进入连接流程，参考 `app-initial-DOX-K1rC.js:764621-764631`。
- `Add account`：仅多账户能力开启且应用在允许范围内时显示；打开应用设置页，参考 `app-initial-DOX-K1rC.js:764632-764650`。
- `Disconnect`：危险色菜单项；代码本身不直接断开，而是打开应用设置页让用户完成管理，参考 `app-initial-DOX-K1rC.js:764651-764670`。

卡片名称旁还可能显示已连接账户 badge。参考项目为每个可访问应用请求 `/aip/connectors/{connector_id}/link`，读取 `owner_profile.email`：`app-initial-DOX-K1rC.js:260675-260703`；badge 本身带 “Connected to {email}” tooltip 并阻止冒泡：`app-initial-DOX-K1rC.js:764475-764507`。它不是右侧动作按钮，但属于“应用”卡片的完整功能范围。

右侧按钮、菜单和提示控件全部阻止冒泡，不会误触整卡点击：`app-initial-DOX-K1rC.js:764832-764846`。

## 3. 整张应用卡片的其余功能

点击卡片主体会打开应用工具弹窗，入口在 `app-initial-DOX-K1rC.js:764541-764552,764799-764814`，详情页把选中的应用 id 保存为弹窗状态：`plugin-detail-page-D-RIq6rf.js:9431-9434`。

工具弹窗必须包含：

- 应用图标、名称、说明和禁用 badge。
- 应用总开关；配置加载中、写入中或不可编辑时禁用，并显示具体原因。参考：`plugin-detail-page-D-RIq6rf.js:667-753`。
- 工具数量与只读/写入类型汇总。
- loading、empty、error 和工具列表四种内容状态。参考：`plugin-detail-page-D-RIq6rf.js:920-970`。
- 工具按 Write、Read 分组；每组默认展开，标题显示数量，可通过带 `aria-expanded` 的按钮独立折叠：`plugin-detail-page-D-RIq6rf.js:1018-1131,1160-1168`。
- 每个工具展示名称、说明、启用状态，以及管理员禁用、配置来源、恢复方式或通用不可用原因：`app-initial-DOX-K1rC.js:764212-764366`、`plugin-detail-page-D-RIq6rf.js:1040-1105`。
- 底部“立即试用”：仅应用可访问、有效启用且配置已加载时可用；点击后创建带 `app://<id>` mention 的新任务。参考：`plugin-detail-page-D-RIq6rf.js:813-859`。

## 4. 当前实现与缺口

当前卡片位于 `desktop-app/src/renderer/src/components/plugin-center/PluginDetailPage.tsx:264-320`，右侧只有三类简单控件：

- 可访问应用显示启停 `Switch`：`PluginDetailPage.tsx:287-295`。
- 不可访问、插件已安装且有 `installUrl` 时显示“连接”：`PluginDetailPage.tsx:267-269,296-309`。
- 可访问且有 `installUrl` 时额外显示“打开”外链：`PluginDetailPage.tsx:310-316`。

当前连接只打开 `installUrl`，窗口重新聚焦后强制刷新详情：`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:798-823`。应用启停已经走固定产品 API 和统一 mutation/readback：`PluginCenterPage.tsx:770-795,1069-1072`。

当前 shared 详情应用 DTO 只有 `id/name/description/category/installUrl/icon/enabled/accessible/canToggle/restriction`：`desktop-app/src/shared/pluginCenterApi.ts:422-435`；`restriction` 只有 `code/message`，没有配置来源和可编辑性：`pluginCenterApi.ts:77-84`。

Main 已经把 `plugin/read`、`app/read`、`app/list` 和安装状态合并成详情：`desktop-app/src/main/pluginCenter/PluginCenterService.ts:322-410,1208-1253`；启停写入最终调用 `apps.<appId>.enabled` 并回读验证：`PluginCenterService.ts:794-807,959-1003`。

provider 当前的 `readAppsForManagement` 只发送 `{appIds}`，并把 `app/read` 手写成 `AppInfo[]`：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts:118-121,386-405`。这会丢失现有协议已经提供的能力：

- `AppsReadParams` 支持 `threadId` 和 `includeTools`：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/app-server-protocol/v2/AppsReadParams.ts:8-21`。
- `AppsReadResponse` 返回 `ConnectorMetadata[] + missingAppIds`：`.../AppsReadResponse.ts:6-9`。
- `ConnectorMetadata` 包含 `toolSummaries`：`.../ConnectorMetadata.ts:6-9`。
- `AppToolSummary` 包含名称、标题、说明、启用状态、禁用原因和只读标志：`.../AppToolSummary.ts:5-8`。
- `config/read` 已返回有效配置、来源和层：`.../ConfigReadResponse.ts:8`；来源类型能区分 user、project、system、MDM、enterprise 和 session flags：`.../ConfigLayerSource.ts:6-35`。

现有 `AppToolSummary` 不包含参考项目直接使用的 `configRestriction`，但 `Config.apps` 已包含应用与单工具开关，`config/read.origins` 能标识配置来源：`.../AppsConfig.ts:9`、`.../AppToolsConfig.ts:6`、`.../ConfigReadResponse.ts:8`。因此工具弹窗、分组折叠和大部分策略提示可由 Main 安全推导；没有来源证据时必须退化成通用“不可用”，不能猜测具体管理员或配置层。

## 5. 完整功能覆盖与能力降级矩阵

参考项目内部还有 ChatGPT 私有连接器 HTTP、OAuth/ToS 弹窗、远程 feature flag 和账户资料。这些不属于当前 Codex app-server 公共应用协议，不能通过 Renderer 或 Main 猜测补齐。

| 参考功能 | 本计划状态 | 当前实现方式 | 无法完全一致的原因 / 解除条件 |
| --- | --- | --- | --- |
| 未安装无右侧动作、管理员锁定、Connect、Connected 菜单和 pending | 完整复刻 | Renderer 状态机 + 现有 `setAppEnabled`/readback | 无。 |
| Reconnect | 降级等价 | 打开经 Main 校验的 `installUrl`，focus 后强制回读 | 参考项目会解析 auth 类型并调用私有 OAuth/reauth API；公共协议若新增 connect/reauth 方法即可解除。 |
| Disconnect | 完整复刻参考实际行为 | 打开 `settingsUrl`，不显示“已断开”成功提示 | 参考代码本身也只是导航到设置页，不是直接断开。 |
| Add account 菜单动作 | 部分覆盖 | 能力被明确标记为 supported 时打开 `settingsUrl` | 当前公共协议没有正式多账户能力字段，参考显示条件来自远程 flag + allowlist；在获得稳定产品契约前生产状态为 unknown 并隐藏。 |
| 已连接账户邮箱 badge | 协议暂不支持 | 当前交付不显示、不伪造邮箱 | 参考通过私有 `/aip/connectors/{id}/link` 读取 `owner_profile.email`；公共 `AppInfo`、`ConnectorMetadata` 均无该字段。需 app-server 新增脱敏连接摘要或新增受信后端数据源。 |
| 原生 OAuth、no-auth、reauth 和 ToS 弹窗 | 协议暂不支持 | 使用外部 `installUrl` 承载授权与条款，返回桌面后回读 | 参考调用 `/aip/connectors/links/noauth`、`/oauth`、`/oauth/reauth` 和 `/{id}/tos`：`app-initial-DOX-K1rC.js:231885-232025,765632-765636`。需公共 app-server 连接 API 才能解除。 |
| 点击整卡打开工具弹窗 | 完整复刻 | 单应用懒加载固定 IPC | 无。 |
| loading/empty/error/ready、工具数量、Write/Read 分组和折叠 | 完整复刻 | `app/read(includeTools:true)` + Renderer 本地折叠状态 | `isReadOnly` 对应参考 READ 分类，文案使用“会更改数据/只读”。 |
| 单工具管理员与配置限制 | 可验证部分完整、缺证据时降级 | `disabledReason` + `config/read.origins` 推导；无来源时显示“不可用” | 当前 `AppToolSummary` 没有直接的 `configRestriction`。未来协议若补字段，可去掉推导和通用兜底。 |
| 应用总开关、限制说明、Try now | 完整复刻 | 现有配置写入 + app mention 草稿 | 无。 |

### 5.1 已连接账户 badge 的决策

- 不得使用 `Account.email` 代替连接器账户邮箱；该字段表示 Codex/ChatGPT 登录账号：`.../Account.ts:6`，可能与 Gmail、Drive 等连接账户完全不同。
- 不得由 Main 或 Renderer 直接调用参考项目的 `/aip/connectors/{id}/link`：当前进程没有该私有 Web 会话契约，且会绕过 app-server、扩大个人信息暴露面。
- 当前交付显示通用 Connected 状态，不显示账户身份，也不产生账户查询网络请求。
- 精确复刻的首选解除方案是由上游 app-server 提供固定的只读连接摘要，例如 `{appId, connected, accountLabel?, connectionCount?, supportsMultipleAccounts?}`；次选是新增有明确认证、权限和隐私审查的受信后端。两者都不属于本轮本仓库改动。

### 5.2 Add account 能力契约

- 参考条件是全局/工作区 `enable_multi_links` 与远程 app allowlist 同时命中：`app-initial-DOX-K1rC.js:764412-764438`。
- `AppInfo.labels` 是无固定键的通用字符串字典：`.../AppInfo.ts:10`；当前协议没有声明 `enable_multi_links` 或等价键，因此本计划撤销“从 labels 猜测”的方案。
- shared DTO 使用三态 `multiAccountCapability: 'supported' | 'unsupported' | 'unknown'`，避免把缺数据误判为不支持。当前 app-server 数据源只能产生 `unknown`，Renderer 对 `unknown` 隐藏 Add account。
- 只有未来出现有版本、文档和测试的产品能力来源时，Main 才能输出 supported/unsupported；不得硬编码所有应用支持，也不得把 E2E fixture 的假字段当成生产能力来源。

### 5.3 `settingsUrl` 的精确契约

输入仅为 `{appId, installUrl?, remotePluginId?}`；Main 负责构造，Renderer 只消费最终 URL。参考算法：`app-initial-DOX-K1rC.js:763990-764001`。

1. 基础地址为去空白后的 `installUrl`；缺失时使用 `https://chatgpt.com`。
2. 有 `remotePluginId` 时，路径设为 `/plugins/<encodeURIComponent(remotePluginId)>`，hash 设为 `settings/Plugins/<encodedRemotePluginId>?product-sku=CODEX`。
3. 无 `remotePluginId` 时，路径设为 `/plugins`，hash 设为 `settings/Connectors?connector=<URLSearchParams(appId)>&product-sku=CODEX&referrer=codex`。
4. 构造后再次执行统一 URL 校验：只接受绝对 HTTP(S)，禁止 username/password、`javascript:`、`file:`、超长 URL 和 Renderer 自定义 fragment。
5. 固定测试向量：
   - `{appId:'google_drive', installUrl:'https://chatgpt.com/install'}` → `https://chatgpt.com/plugins#settings/Connectors?connector=google_drive&product-sku=CODEX&referrer=codex`。
   - `{appId:'x', remotePluginId:'rp/123'}` → `https://chatgpt.com/plugins/rp%2F123#settings/Plugins/rp%2F123?product-sku=CODEX`。
   - 非 HTTP(S)、带凭据或解析失败的 `installUrl` → `settingsUrl` 缺失，相关菜单项禁用/隐藏且不导航。

### 5.4 单工具限制的推导规则

1. `disabledReason === 'disabled_by_admin'` 优先显示“被管理员禁用”，不声称用户可恢复。
2. 对工具 `<toolName>` 查询 `apps.<quotedAppId>.tools.<quotedToolName>.enabled` 的 origin；没有时回退 `apps.<quotedAppId>.enabled`。key path 必须复用 provider 现有安全 quoting 规则：`context-catalog-client.ts:1409-1421`。
3. source 映射为 user、project、system、MDM、enterprise、session 或 managed 通用文案；只把构造后的 app/tool key path 暴露给 Renderer，不暴露 config 文件绝对路径、MDM domain 或企业层 id。
4. user 来源显示用户配置恢复提示；project 来源显示项目配置恢复提示；其他不可写来源只显示来源说明。
5. 工具已禁用但没有 `disabledReason` 或 origin 证据时只显示“不可用”，不得猜测管理员或配置来源。

## 6. 需求摘要

- 用参考状态机替换详情页应用行现有的“Switch + 打开外链”组合。
- 实现 Connected 下拉菜单、Reconnect、Disconnect，并保留 Add account 的 supported 状态分支；当前公共协议只能得到 unknown，因此生产界面隐藏 Add account，直到存在正式能力来源。
- 已连接账户邮箱 badge 标记为协议暂不支持；不得用 Codex 登录邮箱或模拟数据冒充连接器账户。
- 实现禁用来源、不可编辑策略、配置加载、启用中、连接中的禁用/说明/spinner 状态。
- 点击应用行主体懒加载并打开工具弹窗；右侧控件不得误触弹窗。
- 工具弹窗实现应用总开关、默认展开且可独立折叠的 Write/Read 分组、loading/empty/error、单工具限制来源/恢复提示和“立即试用”。
- “立即试用”创建一个新对话草稿，只包含应用 mention，不自动发送。
- 所有写入继续走 `window.desktopApp.plugins` 固定 API；所有 HTTP(S) 页面继续走 `openExternalHttpUrl`。
- 不新增 npm 依赖，不修改 `codex/codex-rs/app-server/`，不把 raw config、绝对路径、凭据、工具输入 schema 或任意 JSON-RPC 暴露给 Renderer。

## 7. 实施步骤

### 步骤 1：先用测试固定状态矩阵

在修改 UI 前，在 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx` 增加参数化状态测试，替换当前只验证 Switch 和简单连接按钮的断言：现有基线见 `:565-646`。

覆盖：未安装无动作、管理员锁定、Connected 菜单、已禁用 Connect、未连接 Connect、pending spinner、限制 tooltip、菜单不触发整卡点击。保留现有布局/inset 回归：`PluginCenterPage.test.tsx:648-708`。

### 步骤 2：修正 provider 的 app/read 契约

修改：

- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/tests/context-catalog-client.test.ts`

工作项：

1. 用生成的 `AppsReadParams`、`AppsReadResponse`、`ConnectorMetadata` 替代手写 `AppReadResponse`。
2. 将 `readAppsForManagement` 输入扩为 `{appIds, threadId?, includeTools?}`，返回 `{apps, missingAppIds}`；继续按最多 100 个 id 分批。
3. `includeTools` 只在打开工具弹窗时传 `true`，插件详情基础读取保持 `false/undefined`。
4. 给 Main 增加一个 provider 级安全配置读取入口，内部复用现有 `config/read` helper，不开放任意 JSON-RPC。
5. 测试请求参数、分批、missing ids、工具字段保留和协议错误。

现有 provider 已通过 AppServerClient 访问 app-server；不得增加 OpenAI-compatible API 或第三方连接器请求。

### 步骤 3：扩展安全 DTO 和固定 IPC

修改：

- `desktop-app/src/shared/pluginCenterApi.ts`
- `desktop-app/src/shared/pluginCenterApi.test.ts`
- `desktop-app/src/preload/pluginCenterBridge.ts`
- `desktop-app/src/preload/pluginCenterBridge.test.ts`
- `desktop-app/src/preload/index.d.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.test.ts`

工作项：

1. 详情应用增加安全展示字段：`mention`、`settingsUrl?`、`multiAccountCapability` 三态、扩展后的 `restriction`；不增加无数据来源的邮箱字段。
2. `restriction` 只暴露脱敏的 `source`、`editable`、`message`；不得暴露 config 文件路径、MDM domain 或企业层 id。
3. 新增固定 `getAppTools` channel，请求只允许 `version/cwd/threadId/app.id`。
4. 结果只允许精简工具摘要：`name/title/description/enabled/disabledReason/readOnly/restriction?`；restriction 只含脱敏 source、kind、message、recoveryKeyPath 和 editable 标记，并限制字符串长度、工具数量和未知字段。
5. URL schema 仅接受绝对 HTTP(S)，拒绝 `javascript:`、`file:`、凭据 URL 和未知字段；输入 `installUrl` 的原 fragment 一律丢弃，输出 fragment 只能由 Main 按第 5.3 节构造。
6. preload 与 main 继续双向 Zod 校验，错误保持脱敏。

### 步骤 4：Main 投影应用动作、配置限制和工具

修改：

- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- `desktop-app/src/main/pluginCenter/PluginCenterService.test.ts`

工作项：

1. 详情读取继续并行合并 `plugin/read + app/read + app/list + installed plugins`，额外读取一次安全的有效配置来源；不把工具摘要加入常规详情。
2. 将 `apps.<appId>.enabled` 的来源映射为脱敏 restriction：user 层可写；project/system/MDM/enterprise/session/legacy managed 层不可通过当前 UI 覆盖。
3. 不从 `AppInfo.labels` 猜测多账户能力；在当前 app-server 数据源下输出 `multiAccountCapability='unknown'`。只有后续正式产品契约才能输出 supported/unsupported。
4. 严格按第 5.3 节的输入、编码、fallback 和安全规则生成 `settingsUrl`；单测覆盖三个固定向量及恶意 URL。
5. 生成稳定 `app://<encoded-id>` mention 和安全显示名，Renderer 不自行拼应用身份。
6. 实现 `getAppTools`：对单个 app 调用 `app/read({includeTools:true, threadId})`，结合 `config/read.origins` 按第 5.4 节生成单工具 restriction，映射 missing、empty、ready 和错误；不返回 raw connector metadata。
7. 保留现有 `setAppEnabled` 串行化、配置写入和 readback 判断；启用被高优先级配置覆盖时返回 warning/partial，不伪报成功。

### 步骤 5：实现应用行右侧状态机

修改：

- `desktop-app/src/renderer/src/components/plugin-center/PluginDetailPage.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`

建议把应用行抽成 `PluginDetailAppRow`，避免继续把状态分支堆在 `Includes` 内。

具体行为：

1. 插件未安装时只展示行，无右侧动作。
2. 管理策略不可编辑且应用不可访问时显示锁定状态，不渲染可点击 Connect。
3. `accessible && enabled` 显示 Connected 菜单；Reconnect 打开 `installUrl`；Disconnect 打开 `settingsUrl`；只有 `multiAccountCapability='supported'` 才显示 Add account，当前 unknown 状态隐藏。
4. `accessible && !enabled` 显示 Connect；只调用 `setAppEnabled(true)`，成功回读后转成 Connected。
5. `!accessible` 显示 Connect；若存在可编辑禁用配置，严格先启用，成功后再打开连接 URL；启用失败时不得打开 URL。
6. 将当前全局 `awaitingAppConnection: boolean` 改为 app id 级状态；只让目标应用显示 spinner/禁用，窗口 focus 后强制刷新并清理状态。
7. `runMutation` 或新增的序列 helper 必须返回成功/失败结果，供“先启用、后连接”判断；现有调用方可忽略返回值。
8. Connected 菜单、Connect、tooltip 与任何 badge 都阻止行点击冒泡。
9. 删除详情应用行现有的“打开 {应用名}”外链，因为参考详情卡片以 Connected 菜单和设置入口承载管理动作。

### 步骤 6：懒加载工具弹窗

修改/新增：

- `desktop-app/src/renderer/src/components/plugin-center/PluginAppToolsDialog.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts`
- `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`

工作项：

1. 行主体支持鼠标、Enter、Space 打开弹窗；使用同级交互结构，不能把右侧 button/menu 嵌套进整行 button。
2. 打开时按 `cwd + threadId + appId` 懒加载工具；缓存 5 分钟、限制缓存条目数量，force refresh 可绕过缓存。
3. 弹窗展示 loading、empty、error、ready；错误态提供“重试”，不关闭整个插件详情页。
4. ready 状态按 `readOnly` 分为 Write/Read；每组默认展开，标题显示数量，支持独立折叠并维护正确 `aria-expanded`。
5. 工具行展示 title/name、description、disabledReason 和第 5.4 节推导的限制来源/恢复提示；工具列表只读，不在本轮增加单工具配置写入。
6. 弹窗头部开关复用 `setAppEnabled`，写入时禁用；不可编辑 restriction 显示原因。
7. “立即试用”仅在 `accessible && enabled && !configPending` 时可用；否则保持可聚焦说明。

### 步骤 7：接通“立即试用”到新对话草稿

修改：

- `desktop-app/src/renderer/src/App.tsx`
- `desktop-app/src/renderer/src/App.test.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`

工作项：

1. 给 `PluginCenterPageProps` 增加产品级 `onTryApp({mention})` 回调，不让详情组件直接操作 conversation runtime。
2. `App.tsx` 复用 `serializeComposerContextReference` 生成 app mention；该 formatter 已校验 `app://`：`desktop-app/src/renderer/src/composer/composerContextDirectiveFormatter.ts:82-88,182-197`。
3. 关闭弹窗、切回 conversation、创建新对话并预填 app mention；不自动发送。
4. 测试 canonical app id、显示名、未发送草稿，以及不可用应用不能触发回调。

### 步骤 8：补完整链路 E2E

修改：

- `desktop-app/tests/e2e/support/plugin-center-app-server.mjs`
- `desktop-app/tests/e2e/plugin-center.e2e.ts`

扩展 fixture，使 `app/read` 支持 `includeTools`、工具摘要、missing id、应用有效启用状态和配置来源；让 config write fixture 能验证 `apps.<id>.enabled`。

E2E 至少证明：

1. 插件详情通过真实 Renderer → preload → main → provider → app-server fixture 读取应用状态。
2. 已禁用应用点击 Connect 会产生固定 `config/batchWrite`，回读后变成 Connected。
3. 未连接应用点击 Connect 打开安全 URL；可编辑禁用时先写配置再打开。
4. Connected 菜单显示 Reconnect、Disconnect；当前多账户能力 unknown 时不显示 Add account，且不会把 fixture 假字段当作生产能力来源。
5. 点击行会发单应用 `app/read(includeTools:true)` 并展示工具；loading/empty/error、默认展开、分组折叠和限制提示可控。
6. 管理策略锁定状态不会发送配置写入或连接请求。
7. “立即试用”生成 app mention 草稿且不自动发送。
8. 420px 窄窗口没有横向溢出，菜单和弹窗可操作。
9. 整条链路不调用 `/aip/connectors/*`，不显示伪造的连接账户邮箱；Reconnect 使用外部 URL 后只通过 focus/readback 更新状态。

## 8. 可测试验收标准

- 未安装插件的应用行右侧没有 Connect、Connected、Switch 或外链动作。
- 管理策略禁用的不可访问应用只显示锁定状态；点击行仍可查看工具说明，但任何启停/连接写入都被阻断。
- 已连接且启用的应用只显示 `Connected` 菜单，不再同时显示 Switch 或“打开”外链。
- Connected 菜单始终包含 Reconnect 和 Disconnect；只有 `multiAccountCapability='supported'` 时包含 Add account。当前公共数据源返回 unknown，因此生产界面隐藏 Add account。
- 当前公共协议下不显示连接账户邮箱 badge，也不得回退显示 Codex 登录邮箱；网络测试证明没有 `/aip/connectors/{id}/link` 请求。
- Disconnect 只打开安全设置页，UI 文案和测试不声称“已断开”。
- `settingsUrl` 对第 5.3 节两个正常向量逐字符相等；非法 scheme、凭据 URL、解析失败或超长值不会导航。
- 可访问但禁用的应用点击 Connect 只写 `apps.<id>.enabled=true`；成功回读后显示 Connected。
- 不可访问应用点击 Connect 会打开 `installUrl`；需要先启用时，写入失败不得打开外链。
- 同一时刻只有目标应用进入 pending/spinner；完成、失败或窗口 focus 回读后状态清理。
- 点击应用行、按 Enter 或 Space 都能打开工具弹窗；点击右侧控件不会打开弹窗。
- 工具弹窗对 loading、empty、error、ready 各有稳定可查询状态；ready 按 Write/Read 分组、默认展开、可独立折叠且 `aria-expanded` 正确。
- `disabled_by_admin`、user、project、managed、无来源五类单工具状态分别显示管理员、用户配置、项目配置、受管配置和通用不可用文案；任何提示都不暴露本地绝对路径、MDM domain 或企业层 id。
- 弹窗开关使用现有 `setAppEnabled`；不可编辑配置不可写且有脱敏说明。
- “立即试用”只有应用可访问且启用时可用；点击后创建一个含 `app://<id>` mention 的未发送新对话草稿。
- `getAppTools` 每次只读取一个 app；未打开弹窗时插件详情不请求 `includeTools=true`。
- Renderer 无法提交任意 config key、任意 app-server method、raw config origin、凭据或非 HTTP(S) URL。
- 不修改 `codex/codex-rs/app-server/`，不新增依赖，不在 desktop main 复制 provider 的 JSON-RPC 映射。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 参考连接流程依赖私有 OAuth/ToS API | 明确标记为降级等价；保留安全 `installUrl` 外链与 focus 后强制回读，不伪造原生 OAuth 成功。 |
| 连接账户邮箱来自私有 link API且属于个人信息 | 当前不显示、不请求、不拿 Codex 登录邮箱替代；仅在公共脱敏连接摘要出现后解除。 |
| Add account 的参考显示条件来自远程 flag/allowlist | 使用 supported/unsupported/unknown 三态；当前 unknown 隐藏，不再猜 labels。 |
| Disconnect 容易让用户误以为已立即断开 | 与参考实际行为一致，只导航到设置页；菜单文案保留，toast 不显示“断开成功”。 |
| 配置来源可能包含本地路径或企业标识 | Main 映射成有限 source 枚举和通用说明，shared schema 拒绝原始层数据。 |
| 单工具 configRestriction 不是 app/read 的直接字段 | 只用 disabledReason 与 config/read origin 的可验证证据推导；证据不足显示通用不可用。 |
| 工具摘要可能很多，拖慢插件详情 | 行点击后单 app 懒加载，设数量上限和 5 分钟缓存。 |
| 连接后窗口 focus 早于服务端状态更新 | focus 强制回读；状态仍未更新时保持原状态，不乐观标记 Connected。 |
| 全局 mutation 让无关卡片一起禁用 | 改为 app id 级 pending；插件级 mutation 与 app/tool mutation分开。 |

## 10. 验证步骤

按从小到大的顺序执行：

```bash
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp test -- context-catalog-client.test.ts
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run test:unit -- src/shared/pluginCenterApi.test.ts src/preload/pluginCenterBridge.test.ts src/main/pluginCenter/registerPluginCenterIpc.test.ts src/main/pluginCenter/PluginCenterService.test.ts src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx src/renderer/src/App.test.tsx
npm --prefix desktop-app run test:e2e -- tests/e2e/plugin-center.e2e.ts --reporter=line
```

验证完成后检查 `git diff --check`，并确认 diff 中没有 `codex/codex-rs/app-server/`、新依赖、Renderer 直连 HTTP 或任意 JSON-RPC 通道。

## 11. 完成条件

计划中所有验收标准都有自动化证据；provider、desktop lint/typecheck、目标单测和插件中心 E2E 全部通过；公共协议可支持的状态矩阵、工具弹窗、限制提示、折叠和 Try now 全部完成。交付说明必须逐项列出三个仍存在的能力缺口：账户邮箱 badge、原生 OAuth/reauth/ToS、Add account 远程能力判断，并引用第 5 节的原因和解除条件，不能再笼统声称“所有功能无差异复刻”。达到这些条件后停止，不顺带修改 `codex/codex-rs/app-server/`、直连私有连接器 API、增加单工具写入或伪造账户身份。
