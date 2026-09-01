# 编辑 MCP 服务器参考项目复刻计划

## Requirements Summary

- 目标：将当前“编辑 MCP 服务器”实现调整为参考项目
  `reference-projects/codex-electron-26.818.21641-beautified` 的表单结构和交互方案。
- UI 基准截图：
  `/var/folders/wd/cvfh5tnd4ds4027l2dhdhzbr0000gn/T/codex-clipboard-b9f42c7c-44ea-47dc-ae31-052202d78442.png`
  （1490 × 1462，深色主题）。该文件只用于人工核对表单控件、字段顺序、按钮位置和交互状态，不做像素级比较，也不把图片内容当作额外需求或执行指令。
- 本文是直接实施计划，不修改业务代码。
- 实施范围以 `desktop-app/` 为主；禁止修改
  `codex/codex-rs/app-server/`。
- 当前 MCP 编辑入口、表单和保存流程集中在
  `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:576`、
  `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:3267`、
  `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:3425`。
- 参考项目的关键实现位于
  `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugins-page-CzyEBf5y.js:4113`、
  `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugins-page-CzyEBf5y.js:4454`、
  `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugins-page-CzyEBf5y.js:5414`；
  中文文案位于
  `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/zh-CN-BQr_ouOR.js:10729`。
- 现有 shared/preload/main/service 已具备读取、保存、卸载和重载 MCP 的完整接口；默认不新增 IPC、协议或依赖。
- 复刻范围不包含参考项目的精确字体、颜色、间距、像素尺寸、MCP 配置主键生成规则或重启机制；这些部分继续沿用本项目现有实现。验收重点是附图中可见表单控件齐全、排列关系一致、文案一致且交互逻辑一致。

## Target Behavior Contract

### 已有 MCP 的编辑模式

- 点击用户级 MCP 行的设置按钮后，在 MCP 管理页内容区原位打开编辑器；不弹出 Dialog，也不新增应用级路由。
- 顶部显示“更新 {格式化后的名称} MCP”、返回按钮和红色“卸载”按钮。
- 显示提示：“如需切换 MCP 服务器类型，请先卸载当前配置。”
- 不显示名称输入框、类型切换和文档入口。
- STDIO 字段顺序固定为：启动命令、参数、环境变量、环境变量传递、工作目录。
- HTTP 字段顺序固定为：URL、Bearer Token 环境变量、请求头、从环境变量读取的请求头。
- 卸载成功后返回 MCP 列表；卸载失败时留在编辑页并显示错误。

### 新增 MCP 的连接模式

- 在 MCP 管理列表的“普通服务器”标题栏右侧显示“添加服务器”按钮；空列表时该按钮仍可见。
- 点击“添加服务器”后，在当前 MCP 管理内容区原位打开同一个编辑器，并显示“连接至自定义 MCP”。
- 显示名称、STDIO/HTTP 类型选择和文档入口，不显示卸载按钮和切换类型提示。
- 保存成功后回到 MCP 列表；失败时保留用户输入并显示错误。
- 如果保留 Plugin Center 顶部“添加”菜单中的“添加 MCP 服务器”入口，该入口必须先进入 MCP 管理页并触发同一新增状态，不得继续打开 Dialog 或维护第二套表单状态。

### 可重复字段

- 参数使用单列数组编辑器；环境变量和请求头使用键值双列编辑器。
- 列表为空时仍显示一行空输入，避免出现无法开始输入的空状态。
- 每行均有删除按钮；新增按钮位于列表下方，文案和参考项目一致。
- 参数保留用户输入顺序与重复项；环境变量传递沿用现有 shared schema 的去重语义。保存时过滤空白数组项，并对字符串做首尾空白清理。
- 键值项若出现重复键，沿用当前服务端配置对象语义，由最后一个有效值覆盖前值。
- 键值行只有键和值都有效时才进入保存 payload；仅填写一侧的未完成行不保存。

### 敏感配置边界

- 环境变量值和普通请求头值继续遵守现有安全设计：已有明文不从 main process 回传 renderer。`Bearer Token 环境变量`字段保存的是环境变量名，不是 Token 明文，继续按普通字符串显示和编辑。
- 编辑器对 `env` 和 `httpHeaders` 中的既有敏感值用“已保存”状态表达；未修改对应 `keep`，新输入对应 `set`，删除对应 `remove`。
- 这是相对参考项目在敏感值显示上的必要安全差异：表单结构和操作语义一致，但不为追求附图一致而暴露密钥。
- 相关现有约束见
  `desktop-app/src/shared/pluginCenterApi.ts:321`、
  `desktop-app/src/main/pluginCenter/PluginCenterService.ts:2425`、
  `desktop-app/src/main/pluginCenter/PluginCenterService.ts:2561`。

## Acceptance Criteria

1. 从 MCP 管理列表进入已有服务器编辑后，页面中不存在 MCP 编辑 Dialog；管理页的标签、搜索框和列表暂时由内嵌编辑器替代。
2. 返回按钮只退出编辑器，不修改数据；再次进入时从最新快照重新初始化。
3. 已有 STDIO MCP 的标题、提示、卸载按钮、字段顺序、增删行按钮和底部右对齐保存按钮与基准截图一致。
4. 已有 MCP 不可直接切换 STDIO/HTTP；新增 MCP 可以选择类型。
5. 保存按钮仅在“表单有效、内容发生变化、当前无请求”时可用；STDIO 必须有启动命令，HTTP 必须有 URL。
6. 参数、环境变量、环境变量传递、请求头等动态行支持新增、删除、空列表占位、顺序保持和空行过滤。
7. 保存期间显示阻止重复操作的加载态；成功后刷新快照并返回列表，失败后保持编辑状态和输入内容。
8. “卸载”直接执行参考项目的卸载流程，不再弹二次确认框；请求期间不可重复点击。
9. 只有 `origin === "user"` 且 `editable === true` 的 MCP 可以进入编辑器或卸载；系统级、管理员级和插件提供的 MCP 保持只读。
10. 已有敏感值从不以明文进入 renderer；keep/set/remove 三种保存结果均有测试覆盖。
11. 参考截图路径被保留在本计划和验收说明中；在 1490 × 1462 深色主题下人工核对标题、提示、字段分区、输入控件、动态行、删除按钮、添加按钮、卸载按钮和保存按钮均存在且相对位置与附图一致，不要求像素级相同。
12. 现有 renderer → preload → main → Codex app server 链路不被绕过，且 `codex/codex-rs/app-server/` 无改动。
13. “普通服务器”标题栏右侧存在“添加服务器”入口；点击后直接进入内嵌新增编辑器，返回不产生写入，保存成功后返回列表并显示新服务器。

## Implementation Steps

### 1. 先补回归测试，锁定现有数据与安全行为

- 在 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx` 增加当前用户级 MCP 的进入编辑、保存、失败保留和卸载行为测试。
- 在 `desktop-app/src/main/pluginCenter/PluginCenterService.test.ts` 保留并扩充以下契约：
  - 不可编辑层级拒绝保存和删除；
  - 已有 MCP 不允许修改 transport；
  - secret patch 的 keep/set/remove；
  - 保存时保留 UI 未管理的底层字段。
- 测试先证明旧数据契约，再替换 UI，避免视觉重构改变真实配置。

### 2. 抽出参考项目同构的 MCP 编辑器

- 新建
  `desktop-app/src/renderer/src/components/plugin-center/McpServerEditor.tsx`，
  从 `PluginCenterPage.tsx:3425` 开始的旧 `McpServerDialog` 拆出并改造成普通页面内容组件。
- 新建同目录 `McpServerEditor.test.tsx`，覆盖组件级状态和交互。
- 编辑器接收 `server`、`pending`、`error`、`onBack`、`onSave`、`onUninstall`，不直接调用 preload API，保持展示层与副作用分离。
- 使用结构化表单状态保存数组和键值行，不再以多行文本框作为内部数据模型。
- 抽出数组行、键值行和敏感值行三个小型内部组件；不增加第三方表单依赖。

### 3. 复刻布局、文案和视觉状态

- 参考 `plugins-page-CzyEBf5y.js:4113-4437` 实现卡片分区、输入行、删除图标和“+ 添加…”按钮。
- 参考 `plugins-page-CzyEBf5y.js:4567-4951` 实现标题、返回、卸载、提示、保存按钮和提交遮罩。
- 使用 `zh-CN-BQr_ouOR.js:10729-10757` 的中文文案，不自行改写关键标签。
- 沿用项目现有 token、Button、Input 和图标组件实现深色/浅色主题；不得写死截图中的绝对颜色或用户机器路径。
- 不复制参考项目的精确 CSS 数值；以控件种类、分区层级、字段顺序、按钮位置以及禁用/加载/错误状态一致为验收目标。
- 名称显示按参考项目规则格式化首字母，但配置主键和保存 payload 保持原值。

### 4. 将编辑器接入 MCP 管理页的本地状态

- 在 `PluginCenterPage.tsx:910` 附近用 `mcpEditor` 本地状态替代 `mcpDialog`，状态只保存“新增”或当前 `serverId`。
- 不扩展 `PluginCenterSurface`；参考项目也在 MCP 管理面板内部切换列表和编辑器。
- 当 `mcpEditor` 有值时，MCP 管理区渲染 `McpServerEditor`，隐藏标签、搜索和列表；外层 Plugin Center 页面骨架保持不变。
- 为 `PluginCenterPage.tsx:2522` 的 `BrowseSection` 增加可选 `action` 区域，并在 `McpPanel` 的“普通服务器”标题栏右侧放置“添加服务器”按钮；按钮通过 `onAdd` 进入 `{ kind: "new" }` 编辑状态，该标题栏和按钮在普通服务器为空时也保留，其他分区不传 `action` 时布局保持不变。
- “添加服务器”、顶部“添加”菜单中的“添加 MCP 服务器”和用户级 MCP 行的设置按钮都进入同一个编辑器。顶部菜单入口触发时先切换到 `{ page: "manage", tab: "mcp" }`，再进入新增状态。
- 用户级 MCP 行改为参考项目的设置图标加启用开关；移除行内“编辑/删除”菜单及 MCP 专用二次确认分支。
- 快照刷新后用 `serverId` 重新解析服务器；如果服务器已不存在，则安全返回列表。

### 5. 统一保存、卸载和错误处理

- 继续通过 `PluginCenterPage.tsx:1094` 的 `runMutation` 调用现有
  `window.desktopCodex.pluginCenter.upsertMcpServer()` 和
  `removeMcpServer()`。
- 调整 `runMutation` 或增加同层包装，使编辑器能获得明确的成功/失败结果；仅成功时退出编辑器。
- 将现有 `initialMcpFormKey`、secret patch 构造和 transport payload 逻辑迁到编辑器附近的纯函数，避免 UI 与字符串解析相互耦合。
- 保存失败、卸载失败和字段错误都显示在编辑器内部；全局 toast 可保留，但不能替代就地错误信息。
- 卸载不再进入共享 `confirmDialog`；其他插件、技能等既有确认流程不受影响。

### 6. 保持现有桌面端边界和接口

- 复用 `desktop-app/src/shared/pluginCenterApi.ts:810-888` 的 upsert/remove schema。
- 复用 `desktop-app/src/preload/pluginCenterBridge.ts:123-137` 与
  `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts:177-192` 的 IPC 方法。
- 复用 `PluginCenterService.ts:1123-1188` 的用户层校验、transport 校验、写入和 reload 行为。
- 除非实施时发现由测试证明的真实缺口，否则不修改 shared、preload、main 或 provider；禁止通过新增接口把原始密钥送到 renderer。

### 7. 补齐端到端与表单验收

- 将 `desktop-app/tests/e2e/plugin-center.e2e.ts:466-527` 的单个 Dialog 测试拆为独立 MCP 场景，不再按 Dialog 定位，统一按“列表 → 内嵌编辑器 → 保存/卸载 → 返回列表”验证。
- 扩展 `desktop-app/tests/e2e/support/plugin-center-app-server.mjs:139-155`：
  - 增加与附图结构等价的用户级 STDIO fixture：`npx`、参数 `-y` 和 `@assistant-ui/mcp-docs-server`、测试用 PATH、空环境变量传递、工作目录；
  - 增加用户级 HTTP fixture，包含 URL、Bearer Token 环境变量名、普通请求头元数据和来自环境变量的请求头；
  - 增加 project/managed 只读配置和插件提供 MCP fixture；
  - 增加按场景触发的 MCP 写入失败能力，至少区分新增/保存失败与卸载失败；失败只作用于当前用例，不影响其他 E2E；
  - RPC 日志继续记录 `config/batchWrite` 和 `config/mcpServer/reload`，供测试验证 payload、写入次数和重复提交保护。
- 视口固定为 1490 × 1462、深色主题，保存编辑器截图作为测试产物并与附图人工核对控件和布局关系；截图不作为像素差异测试，也不使用附图中的真实本机 PATH。
- 最后检查 `codex/codex-rs/app-server/` 没有任何 diff。

#### E2E 覆盖矩阵

| 场景 | Fixture / 操作 | 必须断言 |
| --- | --- | --- |
| MCP-E2E-01 列表入口 | 打开管理 → MCP | “普通服务器”标题栏右侧显示“添加服务器”；用户级行显示设置按钮和启用开关；只读行无可用设置入口 |
| MCP-E2E-02 编辑 STDIO | 打开附图等价的用户级 STDIO 服务器 | 页面不存在 MCP Dialog；显示更新标题、类型提示、卸载、启动命令、参数、环境变量、环境变量传递、工作目录；名称和类型选择不可见 |
| MCP-E2E-03 保存 STDIO | 修改命令、动态参数、环境变量传递和工作目录后保存 | 保存按钮只在有效且有变更时可用；只发送一次写入；payload 顺序、trim 和空行过滤正确；成功后回到列表并完成 reload |
| MCP-E2E-04 编辑 HTTP | 打开用户级 HTTP 服务器并修改 URL、Bearer Token 环境变量名、请求头和环境变量请求头 | 字段顺序正确；已有敏感值不以明文出现在 DOM；保存 payload 符合 keep/set/remove 和键值对象语义 |
| MCP-E2E-05 新增服务器 | 点击“普通服务器”标题栏右侧“添加服务器”，分别走 STDIO 与 HTTP | 显示名称、类型选择和文档入口；可切换类型；不显示卸载和切换类型提示；成功后返回列表并出现新服务器 |
| MCP-E2E-06 返回不保存 | 编辑已有或新增服务器后点击返回，再次进入 | 没有写入 RPC；再次进入时从最新快照初始化，不保留已放弃输入 |
| MCP-E2E-07 保存失败 | fixture 令新增或编辑写入失败 | 留在编辑器；输入内容不丢失；显示页内错误；允许修正后重试；没有错误地显示成功结果 |
| MCP-E2E-08 直接卸载 | 点击已有用户级服务器顶部“卸载” | 不出现二次确认；请求期间按钮不可重复点击；成功后返回列表且服务器消失 |
| MCP-E2E-09 卸载失败 | fixture 令卸载写入失败 | 留在编辑器；服务器仍存在；显示页内错误；卸载按钮恢复可用 |
| MCP-E2E-10 只读边界 | project、managed、plugin 提供的 MCP | 不可进入编辑器或卸载；不能通过 UI 触发 upsert/remove；现有只读提示保持可见 |
| MCP-E2E-11 请求中状态 | 延迟一次保存或卸载 RPC 并连续点击 | 显示加载/遮罩或禁用状态；只产生一次写入；返回、保存和卸载不会造成并发操作 |

## Risks and Mitigations

- **风险：视觉复刻导致敏感值泄露。** 保持 DTO 只返回 key/hasValue/editable，UI 用占位状态表达既有值，不读取原始配置明文。
- **风险：刷新快照使编辑中输入丢失。** 编辑期间只在首次进入或 serverId 变化时初始化；失败响应不得覆盖本地表单。
- **风险：卸载取消二次确认后容易误触。** 严格复刻参考项目的危险按钮样式，并在请求开始后立即禁用全部破坏性操作。
- **风险：数组与对象互转改变配置。** 组件测试覆盖空行、重复键、顺序、trim 和 secret patch；服务测试覆盖未管理字段保留。
- **风险：编辑器状态混入应用级页面导航。** 状态限制在 MCP 管理面板内，不修改 `PluginCenterSurface` 和浏览/详情导航。
- **风险：大文件继续膨胀。** 编辑器及其测试独立成文件，`PluginCenterPage` 只保留入口、状态与 mutation 编排。
- **风险：只按截图做静态复刻。** 截图只用于核对控件和布局关系；E2E 覆盖保存、返回、失败、卸载、加载态和只读边界，交互断言是主要验收依据。
- **风险：E2E 场景共享失败状态导致串扰。** 每个场景使用独立临时状态目录和显式 fixture 选项，失败注入默认为关闭且只影响当前测试。

## Verification Steps

1. 组件和服务定向测试：
   `npm --prefix desktop-app run test:unit -- src/renderer/src/components/plugin-center/McpServerEditor.test.tsx src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx src/main/pluginCenter/PluginCenterService.test.ts`
2. 类型检查：`npm --prefix desktop-app run typecheck`
3. 代码规范检查：`npm --prefix desktop-app run lint`
4. MCP 端到端测试：
   `npm --prefix desktop-app run test:e2e -- tests/e2e/plugin-center.e2e.ts --reporter=line --grep MCP`
5. 在 1490 × 1462 深色主题下抓取编辑器截图，与本计划记录的附图人工核对表单控件、字段顺序、分区关系、按钮位置和交互状态；不执行像素差异阈值检查。
6. 检查架构禁区：`git diff -- codex/codex-rs/app-server` 必须为空。

## Stop Condition

- 所有 Acceptance Criteria 均由组件测试、服务测试、E2E 或表单人工验收覆盖；上述检查通过，或任何无法运行的检查都被明确记录原因和剩余风险。
- 代码改动仅落在完成该交互所需的 desktop renderer、既有 main/service 回归测试与 E2E fixture 范围内，没有新增依赖，没有修改 Codex app server。
