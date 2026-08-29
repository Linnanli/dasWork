# 插件详情能力卡弹窗参考对齐计划

## 目标

在不修改 `codex/codex-rs/app-server` 的前提下，把当前插件详情页的“应用 / MCP 服务器 / 技能”卡片结构、点击行为、弹窗内容和管理动作对齐到参考项目 `reference-projects/codex-electron-26.818.21641-beautified`。

本计划以当前暂存工作树为实现基线：现有改动已补入应用分类、应用型 MCP 识别和应用工具弹窗入口，实施时必须增量修改，不得覆盖或回退这些用户改动。

## 已确认的参考行为

| 资源类型 | 参考项目行为 | 本项目应实现的结果 |
| --- | --- | --- |
| 应用 | 点击整行打开应用工具弹窗 | 保留当前懒加载工具数据流，重做弹窗信息层级、滚动区、工具分组与 footer |
| 应用型 MCP | 复用应用卡片，点击后打开同一个应用工具弹窗 | 复用 `PluginDetailAppRow` 与 `PluginAppToolsDialog` |
| 配置型 MCP | 不打开独立详情弹窗；行内提供“打开/设置 MCP”按钮和启停开关 | 按参考实现提供设置入口与开关，不新增虚构的 MCP 详情弹窗 |
| 技能 | 点击整行打开技能预览弹窗，懒加载并渲染 `SKILL.md`；行内开关/菜单不误触发弹窗 | 新增技能内容读取 API、技能预览弹窗、Try now、复制 Markdown 与打开本地文件动作 |

证据：

- 应用工具弹窗的 header、启用操作、工具摘要、加载/空/错误态、Try now 位于 `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugin-detail-page-D-RIq6rf.js:613`、`:667`、`:807`、`:861`、`:920`、`:980`。
- 工具分组默认展开，按 Write/Read 分类并使用双列工具行，位于同文件 `:1021`、`:1066`、`:1160`。
- 通用“卡片 + 预览弹窗”包装器 `_c` 负责整行点击、子操作防误触和 modal body/footer，位于同文件 `:2946`、`:2971`、`:3031`、`:3063`。
- 技能卡 `wc` 的弹窗读取技能正文、显示 header actions 和 Try now，位于同文件 `:3142`、`:3566`、`:3683`、`:3701`。
- 参考技能正文通过本地文件读取或 `plugin/skill/read` 懒加载，去除 frontmatter 与重复一级标题后渲染 Markdown，位于 `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:329441`、`:329509`、`:329775`。
- 应用型 MCP 复用应用卡，配置型 MCP 使用 `Zc` 行，只提供设置和启停动作，位于 `plugin-detail-page-D-RIq6rf.js:4941`、`:4978`、`:5020`、`:5300`、`:5337`。
- 三类列表使用可展开容器，默认显示 5 项，位于同文件 `:5567`、`:5613`。

## 当前实现差距

- `PluginDetailPage.tsx` 中应用行已可点击；应用型 MCP 已在当前暂存改动中开始复用应用行；配置型 MCP 仍是静态 `<div>`；技能仍是静态行加开关：`desktop-app/src/renderer/src/components/plugin-center/PluginDetailPage.tsx:290`、`:326`、`:346`、`:359`、`:477`。
- `PluginAppToolsDialog.tsx` 已有加载、错误、空态、读写分组和 Try now，但开关位于单独边框块、整个弹窗滚动、缺工具摘要、工具行不是参考双列布局：`desktop-app/src/renderer/src/components/plugin-center/PluginAppToolsDialog.tsx:49`、`:69`、`:85`、`:106`、`:163`、`:207`。
- 详情页只在打开应用时维护 `selectedAppId` 和应用工具资源；没有技能正文资源：`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:594`、`:601`、`:1213`。
- detail surface 当前只额外订阅 apps，没有订阅 MCP snapshot；但现有 MCP snapshot 已包含 enabled、connected、toolCount、origin、editable、transport 和 restriction，可直接复用：`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:589`、`:593`；`desktop-app/src/shared/pluginCenterApi.ts:298`、`:371`。
- 插件详情技能 DTO 只有名称、描述、图标、启用态；插件中心没有技能正文读取 IPC：`desktop-app/src/shared/pluginCenterApi.ts:501`、`:809`。
- provider 已支持通用 app-server JSON-RPC，并已有生成类型；app-server 已提供本地 `fs/readFile` 和远程 `plugin/skill/read`，无需修改执行基座：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/context-catalog-client.ts:240`；`codex/codex-rs/app-server/README.md:192`、`:218`；`desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/app-server-protocol/v2/PluginSkillReadParams.ts:1`。
- 当前 `setMcpServerEnabled` 只允许 editable user server，无法对齐参考项目的插件 MCP 独立启停：`desktop-app/src/main/pluginCenter/PluginCenterService.ts:865`。
- 当前应用 Try now 已能生成 app composer reference；技能还没有等价入口：`desktop-app/src/renderer/src/App.tsx:715`、`:729`、`:837`。

## 范围与边界

### 本次包含

- 应用工具弹窗的结构、视觉层级、工具摘要、折叠分组、禁用提示和 Try now 对齐。
- 应用型 MCP 复用应用工具弹窗。
- 配置型 MCP 行的设置入口、启停能力、只读/策略限制提示。
- 技能预览弹窗、技能正文懒加载、Markdown 渲染、开关、Try now、复制 Markdown、本地文件打开。
- 三类能力列表默认显示 5 项并支持展开/收起。
- 键盘、焦点、子操作防误触、loading/error/empty/retry 和 mutation 回读。

### 本次不包含

- 不修改 `codex/codex-rs/app-server`。
- 不绕过 app-server 直接请求模型、插件远程服务或第三方接口。
- 不给配置型 MCP 发明参考项目不存在的独立详情弹窗。
- 不改插件安装、应用连接和 MCP 编辑表单的既有业务语义。

## 可验收标准

1. 点击应用卡或应用型 MCP 卡，打开同一个应用工具弹窗；打开前不请求工具，打开后只为所选 app 懒加载一次。
2. 应用弹窗 header 显示 48px 左右图标、名称、“应用”类型标识、描述、禁用状态和启用开关；开关操作不会关闭或重复打开弹窗。
3. 应用弹窗正文显示“该应用包含 N 个操作（写入 X、读取 Y）”摘要，并按写入/读取分组；分组默认展开，可折叠，工具行按“名称/限制 + 描述”双列展示。
4. 应用工具 loading、missing、empty、error、ready 五种状态都有稳定 UI；error 可重试；不可用工具降透明度并展示 restriction 文案。
5. Try now 只在应用已启用且可访问时可用；禁用时有明确 tooltip；点击后关闭弹窗、新建会话草稿并填入 app reference，不自动发送。
6. 配置型 MCP 行不打开独立详情弹窗；设置按钮进入插件中心 MCP 管理页，未配置时表达“设置”，已配置时表达“打开设置”。
7. 已安装且允许写入启用覆盖的 MCP 行显示开关；user MCP 与 plugin MCP 均可独立启停；project/system/managed 限制时禁用开关并显示 restriction，且 mutation 仍由 main 层二次校验。
8. 点击技能行打开技能预览弹窗；点击行内开关、更多菜单或菜单项不会误开/重复打开弹窗；Enter 和 Space 与鼠标点击等价。
9. 技能弹窗打开时才请求正文；本地/已安装技能走 app-server `fs/readFile`，未安装远程插件技能走 `plugin/skill/read`；renderer 永远不能提交任意文件路径给读取接口。
10. 技能正文去除 YAML frontmatter 和与卡片标题重复的首个 H1 后，用现有 `Streamdown` 渲染；具有 loading、missing、error、retry 状态。
11. 已安装且启用的技能提供 Try now，点击后新建会话草稿并填入 skill reference，不自动发送；可复制清洗前的 Markdown；本地技能可通过既有 `openLocalPath` 打开。
12. 每个能力列表默认最多显示 5 项；有隐藏项时显示参考式展开行，展示隐藏项名称/图标预览；展开后可收起。
13. Dialog 支持 Esc 和遮罩关闭、焦点约束与关闭后焦点恢复；这些行为继续由现有 Radix Dialog primitive 提供：`desktop-app/src/renderer/src/components/ui/dialog.tsx:41`。
14. renderer 不新增 Node/Electron 直连；新增读取和 mutation 均经过 shared schema → preload bridge → main service → provider/app-server。
15. `git diff -- codex/codex-rs/app-server` 为空；现有暂存修改不被回退。

## 实施步骤

### 1. 先锁定当前工作树与参考语义

- 保存当前 `git status --short` 和 `git diff --cached --stat`，把已暂存的 8 个插件中心/provider 文件视为基线；禁止整文件替换。
- 在 `PluginCenterPage.test.tsx` 先补参考行为矩阵的回归断言：应用型 MCP 复用 app modal、配置型 MCP 只显示 settings/toggle、技能行可打开 preview、子操作不触发 preview。
- 更新现有“静态 MCP 行”和“技能只有开关”的断言，避免旧测试把错误行为锁死：`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx:537`、`:790`、`:1011`。

### 2. 建立参考式能力卡和弹窗外壳

- 新建 `desktop-app/src/renderer/src/components/plugin-center/PluginCapabilityDialog.tsx`，封装固定 header、header actions、内部滚动 body 和 footer；继续使用现有 `Dialog`，不改全局 primitive。
- 在 `PluginDetailPage.tsx` 抽出可复用的 `PreviewableCapabilityRow`：`role="button"`、`tabIndex=0`、Enter/Space 打开、hover/focus 样式一致；actions 区统一 `stopPropagation`/`preventDefault`，复刻参考 `_c` 的防误触语义。
- 保持配置型 MCP 行为例外：它不是 preview row，只保留设置/开关操作。
- 为测试保留稳定 `data-slot`：`plugin-detail-app-row`、`plugin-detail-mcp-server`、`plugin-detail-skill-row`、`plugin-app-tools-dialog`、`plugin-skill-preview-dialog`。

### 3. 对齐应用工具弹窗

- 重构 `PluginAppToolsDialog.tsx:25` 使用 `PluginCapabilityDialog`：把启用开关移入 header actions，增加 disabled badge；body 使用独立 flex scroll area，footer 只保留右对齐 Try now。
- 根据现有 `PluginCenterAppToolSummary.readOnly` 计算写入/读取数量；数据含义保持不变，只把 UI 顺序与参考对齐为 Write 在前、Read 在后：`desktop-app/src/shared/pluginCenterApi.ts:573`。
- 把 `ToolGroup` 改成 sticky section header + count + chevron；把 `ToolRow` 改成桌面双列、窄窗单列，保留 `available` 和 restriction。
- 用 Tooltip 包裹禁用 Try now 和受策略限制的开关，避免“禁用但无解释”。
- 保留 `getPluginCenterAppToolsResource` 的现有 key、cache、invalidate/readback 逻辑：`desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts:447`；`PluginCenterPage.tsx:751`。

### 4. 按参考项目补齐 MCP 行，而不是新增错误弹窗

- detail surface 同时订阅 `mcpResource`，并在刷新详情时并行刷新 detail/apps/mcp：`PluginCenterPage.tsx:578`、`:589`、`:720`。
- 在 `PluginCenterPage.tsx:1158` 处把 `mcpState.data?.mcp` 传给 `PluginDetailPage`；在 `resolvePluginMcpServers` 中按 server name 合并 `userServers` / `pluginServers`，未命中则保留 setup-only 行。
- 保留当前暂存改动中的 app alias 识别；应用型 MCP 一律走 `PluginDetailAppRow` 和 `onOpenAppTools`：`PluginDetailPage.tsx:414`、`:428`、`:477`。删除当前 `detail.apps` 未命中时退化为静态 `PluginMcpAppRow` 的分支；把 directory app 适配为弹窗需要的 app view model，并让 `selectedApp` 同时从 detail apps 与 directory apps 解析，确保所有被识别的 app-MCP 都能打开工具弹窗。
- 将 config 分支替换为 `PluginMcpServerRow`：图标、名称、连接/工具数量摘要、settings icon、installed 时的 toggle、restriction tooltip。设置入口通过 `onSurfaceChange({ page: 'manage', tab: 'mcp' })` 落到现有管理页，不复用 `McpServerDialog` 伪装成详情弹窗：`PluginCenterPage.tsx:2652`。
- 在 shared MCP DTO 增加独立 `canToggle`，不要复用 `editable`：`editable` 继续表示“可编辑连接配置”，plugin MCP 可保持 `editable: false` 但在用户配置层允许 `canToggle: true`。
- 更新 `normalizeMcpForUi`，使用 `mcp_servers.<name>.enabled` 的有效值与 origin/restriction 计算 plugin MCP 的 enabled/canToggle；更新 `setMcpServerEnabled` 二次校验，使其允许 snapshot 中 `canToggle` 的 user/plugin server，拒绝 project/system/managed 覆盖：`PluginCenterService.ts:2026`、`:2304`、`:865`。

### 5. 新增安全的技能正文读取链路

- 在 `pluginCenterApi.ts` 新增：
  - `getSkillContents` IPC channel；
  - request：request context + plugin ref + skill `{ id, name }`，不接受 renderer 提交的任意 path；
  - result union：`ready { contents, localPath? }` / `missing`；对正文长度设置明确上限。
- 在 `context-catalog-client.ts` 新增窄接口：
  - 本地技能：`fs/readFile`，使用生成的 `FsReadFileParams/FsReadFileResponse` 并解码 UTF-8；
  - 远程未安装技能：`plugin/skill/read`，使用现有生成的 `PluginSkillReadParams/PluginSkillReadResponse`；
  - 为 unsupported、null contents、非 UTF-8/超长内容提供可判定错误。
- 在 `PluginCenterService.getSkillContents` 内重新 `resolvePluginLocator` 并读取 plugin detail，按 skill id/name 找到可信 skill：
  - 已安装/本地 skill 只读取 app-server 返回的 `SkillMetadata.path` 或 `PluginDetail.skills[].path`；
  - 远程 skill 只使用服务端返回的 `remoteMarketplaceName + remotePluginId + skillName`；
  - renderer 传入的 id 仅用于匹配，绝不直接作为文件读取参数。
- 把新方法接入 `registerPluginCenterIpc.ts`、`pluginCenterBridge.ts`、`preload/index.d.ts` 和对应 IPC parse/readback 测试；不暴露 raw provider client。

### 6. 新增技能预览资源和弹窗

- 在 `pluginCenterDataResource.ts` 增加按 `pluginRef + skillId + cwd` 缓存的 skill contents resource；仅当 selected skill 非空且 dialog open 时订阅，关闭不主动刷新。
- 新建 `PluginSkillPreviewDialog.tsx`：
  - header：技能图标、名称、“技能”类型、disabled badge、开关、更多菜单；
  - body：loading/missing/error/retry，ready 时用现有 `Streamdown` 渲染；
  - 渲染前删除 YAML frontmatter 与重复 H1，但复制动作使用服务返回的原始 Markdown；
  - footer：已安装技能显示 Try now，远程未安装技能显示 Close；
  - 本地 path 可用时提供“打开”，所有 ready 内容提供“复制 Markdown”。
- 在 `PluginDetailPage.tsx:359` 用 previewable row 替换静态技能行；`OptimisticSkillSwitch` 继续复用，行内开关和 modal 内开关都走同一个 `onSkillToggle`。
- 在 `PluginCenterPage.tsx:595` 增加 selected skill 状态和内容资源；mutation 后刷新 detail/skills，但不要因为开关变化重复丢失或重开 modal。

### 7. 接通技能 Try now 与本地打开动作

- 在 `PluginCenterPage` props 增加 `onTrySkill({ mention })` 和 `onOpenSkillFile(path)`；只对具有可信 localPath/installed id 的技能生成 skill reference。
- 在 `App.tsx:715` 附近新增 `handleTrySkill`，使用现有 `serializeComposerContextReference({ type: 'skill', ... })`，切回 conversation、新建会话并只填草稿，不自动发送；调用形态与 `handleTryApp` 保持一致：`App.tsx:729`。
- 本地文件打开复用已存在的 `window.desktopApp.codex.openLocalPath` preload API，不新增 renderer Node 权限：`desktop-app/src/shared/codexIpcApi.ts:686`；`desktop-app/src/preload/index.ts:137`。

### 8. 对齐能力列表展开行为

- 新增本地 `ExpandableIncludedList`，默认上限 5；隐藏项存在时渲染“查看更多/收起”行，并展示最多 3 个隐藏项的图标或名称预览。
- 应用按当前已实现的 category 分组后，各 category 内独立展开；MCP 和 skills 按 section 展开。保留当前 `--detail-page-inline-inset` 对齐线：`PluginDetailPage.tsx:290`、`:326`、`:359`、`:651`。
- 展开按钮必须是原生 button，具有 `aria-expanded` 和可读 label；不与卡片点击事件互相触发。

### 9. 测试与视觉验证

- `PluginAppToolsDialog.test.tsx`：补 header switch、摘要、默认展开/折叠、双列内容语义、disabled tool、Try tooltip、loading/missing/empty/error/retry。
- 新增 `PluginSkillPreviewDialog.test.tsx`：本地/远程 ready、frontmatter/H1 清洗、原文复制、打开文件、Try now、error retry、关闭后不继续展示旧 skill。
- `PluginCenterPage.test.tsx`：覆盖 app 与 app-MCP 复用弹窗、config MCP settings/toggle/restriction、技能行点击和子操作防误触、skill lazy loading、mutation 回读、5 项折叠。
- shared/preload/main/provider 测试：覆盖 request/result parse、安全 locator、`fs/readFile`、`plugin/skill/read`、超长/缺失正文、plugin MCP canToggle 与 managed 拒绝。
- E2E `desktop-app/tests/e2e/plugin-center.e2e.ts:217`：保留应用弹窗键盘/ESC/Space/Try 断言，新增技能弹窗键盘/ESC/Markdown/Try，以及配置型 MCP settings 行为；更新 420×900 与桌面宽度截图。

## 验证命令

按最小到完整顺序执行：

```bash
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run lint
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp run typecheck
npm --prefix desktop-app/vendors/ai-sdk-provider-codex-asp test -- context-catalog-client.test.ts

npm --prefix desktop-app run test:unit -- src/renderer/src/components/plugin-center/PluginAppToolsDialog.test.tsx src/renderer/src/components/plugin-center/PluginSkillPreviewDialog.test.tsx src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts
npm --prefix desktop-app run test:unit -- src/shared/pluginCenterApi.test.ts src/preload/pluginCenterBridge.test.ts src/main/pluginCenter/registerPluginCenterIpc.test.ts src/main/pluginCenter/PluginCenterService.test.ts
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run lint
npm --prefix desktop-app run test:e2e -- tests/e2e/plugin-center.e2e.ts --workers=1 --reporter=line

git diff --exit-code -- codex/codex-rs/app-server
```

视觉检查至少覆盖：窄窗 420×900、普通桌面宽度、浅色/深色主题、长工具描述、长技能正文、仅键盘操作。

## 风险与缓解

- **当前工作树已暂存大量相关改动。** 实施前后分别记录 staged/unstaged diff；只做增量 patch，测试 fixture 以当前 schema 为准。
- **技能读取可能成为任意文件读取口。** request 不接受 path；main 重新解析 plugin/skill locator，只有 app-server/plugin detail 返回的可信 path 才进入 `fs/readFile`。
- **远程技能正文接口可能不受旧 app-server 支持。** 把 method-not-found 映射为明确 unavailable/error UI，不回退到 renderer 网络请求。
- **plugin MCP 的 editable 与 canToggle 语义不同。** 单独建模；main 按有效 config origin 二次校验，禁止 managed/project/system 路径被 UI 绕过。
- **整行点击与开关/菜单嵌套容易误触或产生无效嵌套 button。** 使用可聚焦 row 容器 + 独立原生 action buttons，统一事件保护，并用键盘测试锁定。
- **长正文和长工具列表可能造成整个 dialog 漂移。** 固定 header/footer，只让 body 内部滚动；窄屏改为单列。
- **Markdown 链接可能打开不安全目标。** 复用 `Streamdown` sanitization；外链只走现有 `openExternalHttpUrl`，本地打开只使用 main 返回的可信 localPath。

## 完成定义

- 15 条验收标准全部有自动化断言或明确视觉证据。
- provider、desktop targeted tests、typecheck、lint、插件中心 E2E 全部通过；若环境阻塞，报告具体命令和原始错误。
- `codex/codex-rs/app-server` 无改动。
- 参考行为矩阵不再存在以下偏差：应用弹窗结构不一致、技能没有正文预览、配置型 MCP 是死行、app-MCP 不复用 app modal、超过 5 项无法展开。
