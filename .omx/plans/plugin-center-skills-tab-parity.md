# 插件中心「技能」Tab 对齐参考实现计划

> 模式：`$plan` 直接规划模式
> 状态：可实施
> 目标范围：`desktop-app/`；禁止修改 `codex/codex-rs/app-server/`

## 1. 目标与成功定义

在现有插件中心实现上补齐「技能」Tab，使其达到附图所示的核心体验：

- 独立的技能标题、副标题和“搜索技能”输入框。
- 顶部“已安装”技能概览，双列展示，最多预览 6 项，并用一行摘要说明其余技能。
- 下方提供“个人 / 系统 / 推荐”三个分类，并在分类内展示完整技能列表。
- 个人和系统技能来自真实 `skills/list`；推荐技能来自独立的 curated skills 数据源，不再把“插件附带技能”误当成推荐技能。
- 推荐技能可以直接安装为个人技能；安装后立即从“推荐”消失，并出现在“已安装”和“个人”中。
- 搜索、加载、空数据、过滤无结果、推荐源失败和安装中状态均有明确反馈。
- 保留当前技能预览、启停、卸载及插件详情能力，不破坏插件、应用、MCP 和管理页。

## 2. 当前实现与参考实现结论

### 2.1 已具备的基础

- 技能浏览 Tab、标题和副标题已经存在，技能数据通过独立 supplemental resource 加载；进入技能页时还会同时加载插件目录和已安装插件，用于当前的插件技能预览上下文（`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:571-622`、`650-717`）。
- 浏览状态已经能够保存 `tab/category/search/scrollTop`，可直接承载技能分类切换和返回恢复（`desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx:88-108`、`1054-1075`）。
- 共享协议已经区分 `personal/workspace/project/plugin/system/unknown` scope，并包含图标、安装、推荐、启停、卸载和限制字段（`desktop-app/src/shared/pluginCenterApi.ts:219-252`）。
- Main 已能把 app-server `skills/list` 的 `user/repo/system` 映射为个人、项目、系统技能，并能将插件技能合并进技能快照（`desktop-app/src/main/pluginCenter/PluginCenterService.ts:2132-2222`、`2792-2802`）。
- 技能启停和个人/仓库技能卸载已有安全边界；不可移除的系统/插件技能不会被当成本地目录删除（`desktop-app/src/main/pluginCenter/PluginCenterService.ts:992-1033`、`1971-1978`）。
- 当前 bridge 严格使用固定 IPC channel 与双端 schema 校验，新增能力应继续沿用这一模式（`desktop-app/src/preload/pluginCenterBridge.ts:31-127`、`desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts:64-181`）。

### 2.2 主要差距

| 差距 | 当前证据 | 目标行为 |
| --- | --- | --- |
| 搜索文案错误 | 浏览页 placeholder 固定为“搜索插件”（`PluginCenterPage.tsx:1595-1616`） | 技能 Tab 显示“搜索技能”，插件 Tab 保持“搜索插件” |
| 无三类切换 | `BrowseSkills` 只渲染“已安装技能 / 推荐来源”两个静态区块（`PluginCenterPage.tsx:2531-2588`） | 下方显示“个人 / 系统 / 推荐”分类并保留搜索状态 |
| 无已安装概览 | 当前把全部 installed 技能一次性展开（`PluginCenterPage.tsx:2551-2568`） | 顶部只预览 6 项，剩余项显示名称摘要与计数 |
| 浏览卡片动作不一致 | 当前每行右侧是启停 switch（`PluginCenterPage.tsx:2590-2625`） | 浏览页已安装项用已安装勾选标识；启停仍放在管理页，推荐项显示安装动作 |
| 推荐语义错误 | Main 把插件详情中的技能统一标成 `recommended: true`，未安装时实际安装其所属插件（`PluginCenterService.ts:2162-2218`、`PluginCenterPage.tsx:970-980`） | 推荐技能来自独立 curated catalog，并直接复制安装到个人技能目录 |
| 状态表达不足 | 技能数组为空时只有一个通用 EmptyState（`PluginCenterPage.tsx:2542-2549`） | 区分初次加载、无技能、搜索无结果、推荐源错误、安装中和刷新失败 |
| 自动化覆盖不足 | E2E 只点击技能 Tab 并检查一个 Workspace Skill（`desktop-app/tests/e2e/plugin-center.e2e.ts:48-70`），fixture 也只有一个 repo skill（`desktop-app/tests/e2e/support/plugin-center-app-server.mjs:308-326`） | 覆盖搜索、三分类、概览上限、推荐安装和安装后的分类迁移 |

### 2.3 参考实现中应复用的行为

- 参考技能页把已安装技能和推荐技能作为两份独立状态加载，并提供独立的推荐安装 mutation（`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/skills-page-D-y6JxYW.js:5079-5113`）。
- 搜索输入明确使用 “Search skills”，并按技能名称/描述过滤（`skills-page-D-y6JxYW.js:5251-5281`、`5147-5155`）。
- 已安装和推荐区分别处理 loading、无数据、过滤无结果与错误状态（`skills-page-D-y6JxYW.js:5531-5675`、`5693-5818`）。
- 推荐技能通过独立 `recommended-skills` 查询获取，5 分钟视图缓存；安装 payload 使用 `skillId/repoPath/installRoot`（`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/use-recommended-skills-BcrwY9-W.js:19-46`、`80-90`）。
- 参考项目从 `openai/skills` 的 `skills/.curated` 与 `skills/.experimental` 做 sparse checkout，10 分钟后刷新，失败时回退本地缓存（`reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:72249-72361`）。
- 推荐条目由 `SKILL.md` 与 `agents/openai.yaml` 解析出名称、描述、短描述和图标；安装前验证目标路径，再复制到个人技能目录（`.vite/build/src-PzwkD6WC.js:72409-72525`、`72638-72712`）。
- 参考实现通过规范化 id/name/display name/path 来判定“推荐技能是否已安装”，避免重复展示与重复安装（`reference-projects/codex-electron-26.818.21641-beautified/webview/assets/plugin-detail-page-D-RIq6rf.js:1256-1305`）。

> 说明：当前参考 bundle 的技能页源码仍是“Installed / Recommended”两个区块，没有附图中的“个人 / 系统 / 推荐”三段式 Tabs（`skills-page-D-y6JxYW.js:5397-5477`）。本计划以附图作为最终页面结构，以参考源码作为数据、安装、安全和状态处理依据。

## 3. 范围与明确决策

### 3.1 本次纳入

1. 本地桌面端的技能搜索、已安装概览、三分类、推荐目录、推荐安装、安装后刷新。
2. 完整 shared schema → main service → IPC → preload → renderer resource → UI 链路。
3. 关键单测与一条不依赖公网的 Electron E2E。
4. 桌面宽度双列、窄窗口单列、键盘可操作和可读的按钮标签。

### 3.2 本次不纳入

- 不实现参考项目的远程 Host 选择、远程路径安装或 workspace installRoot 选择；当前产品目标和附图均为本机技能页。
- 不新增“新建技能”、Skill Creator 唤起、顶部刷新 CTA 或首次引导。
- 不修改 Codex app server，不绕过现有 app-server 聊天链路。
- 不让运行时代码依赖 `reference-projects/`；参考目录只用于分析。
- 不改变管理页的技能启停/卸载职责，也不改变插件详情中的插件技能入口。

### 3.3 分类规则

- **已安装概览**：所有 `installed === true` 的技能，不分 scope；按稳定显示名排序，最多展示 6 项。
- **个人**：已安装且 scope 为 `personal/workspace/project/plugin/unknown`。这样现有仓库技能和插件技能不会在新 UI 中消失；项目/工作区来源可继续通过副文案或 badge 标识。
- **系统**：已安装且 scope 为 `system`。
- **推荐**：独立 curated catalog 中、经规范化匹配后尚未安装的技能。当前插件 catalog 产生的 `recommended: true` 不再作为该分类的数据源。
- **安装结果**：推荐技能固定安装到 `$CODEX_HOME/skills/<skill-id>`，因此刷新 `skills/list` 后归入“个人”。

## 4. 可测试验收标准

1. 进入插件中心“技能”Tab 后，页面标题为“技能”、副标题为“通过任务专用技能扩展 Codex”，搜索框 placeholder 与可访问标签均为“搜索技能”；切回插件 Tab 后恢复“搜索插件”。
2. “已安装”区最多渲染 6 张技能卡；如果还有隐藏项，摘要格式为“查看 {前两项名称}{若仍有更多则追加‘，另有 N 项’}”，其中 `N = 隐藏项总数 - 已点名项数`。
3. 已安装卡片显示图标、单行标题、单行截断描述和右侧勾选标识；点击卡片仍打开现有技能预览，浏览页不再使用启停 switch。
4. 页面显示“个人 / 系统 / 推荐”三个可键盘操作的 Tabs；默认选中“个人”，切换分类时保留搜索词并将滚动位置复位到顶部。
5. 个人分类显示所有非系统已安装技能，系统分类只显示 system scope，推荐分类只显示独立 curated catalog 中尚未安装的技能；任何技能不会同时出现在“推荐”和已安装列表。
6. 搜索对当前活动分类和顶部已安装概览同时生效，至少匹配 `name/displayName/description/tags`；推荐技能额外匹配 `shortDescription`。搜索大小写不敏感并忽略首尾空白。
7. 推荐技能使用独立 API 加载；加载失败但有缓存时展示缓存并给出非阻塞警告，无缓存时展示错误与“重试”按钮，不能把整个技能页降级为白屏。
8. 点击推荐技能的安装按钮后只禁用该条目并显示安装中状态；安装成功后强制刷新已安装技能，条目从“推荐”消失并出现在“已安装/个人”；失败时保留条目并显示可重试错误。
9. 推荐安装拒绝绝对路径、`..` 穿越、超出 curated repo 的源路径、超出 `$CODEX_HOME/skills` 的目标路径和覆盖既有目录；失败不得删除或改写现有技能。
10. 窗口足够宽时技能列表为两列，窄窗口为单列且 `scrollWidth <= clientWidth + 1`；图标 fallback、长标题和长描述不会撑破布局。
11. 插件浏览、插件详情、技能管理页、应用、MCP，以及当前本地技能预览/启停/卸载测试全部继续通过。
12. 实现不包含 `codex/codex-rs/app-server/` 变更，不新增第三方依赖。

## 5. 实施步骤

### 步骤 1：先锁定当前行为与新 UI 状态模型

**文件**

- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`
- `desktop-app/src/shared/pluginCenterApi.test.ts`

**工作**

1. 为当前技能标题、技能预览、个人技能卸载和插件技能预览补充/保留回归断言，避免重构 BrowseSkills 时丢失已有能力。
2. 新增 `PluginCenterSkillBrowseCategory = 'personal' | 'system' | 'recommended'`，将 browse surface 调整为按 `tab` 区分的联合类型：插件分类仍接受插件 category，技能分类只接受上述三值。
3. 明确搜索、分类和滚动恢复测试，防止从详情返回后丢失技能页面上下文。

**完成证据**：先新增的行为测试在实现前准确失败，且失败点仅对应搜索文案、分类、概览或推荐链路。

### 步骤 2：建立独立推荐技能协议

**文件**

- `desktop-app/src/shared/pluginCenterApi.ts`
- `desktop-app/src/shared/pluginCenterApi.test.ts`

**工作**

1. 新增 `PluginCenterRecommendedSkill` schema：`id/name/description/shortDescription/iconSmall/iconLarge/repoPath`。
2. 新增 `getRecommendedSkills` request/result：返回 `skills/fetchedAt/source/error`，其中 source 至少为 `git | cache`。
3. 新增 `installRecommendedSkill` request/result：请求仅接受已验证的 `id/repoPath`；结果沿用 mutation 的 `status/message/changedSections`，成功时 `changedSections` 包含 `skills`。
4. 新增两个固定 IPC channels 和 `DesktopPluginCenterApi` 方法；所有字符串继续受长度限制，`repoPath` 只允许相对 POSIX 路径格式。
5. 保留现有 `PluginCenterSkill.recommended` 以兼容插件详情/旧数据，但在 browse 推荐分类中不再使用它。

**完成证据**：schema 接受合法推荐条目，拒绝绝对路径、空 id、过长字段和 `../` 路径。

### 步骤 3：在 Electron Main 实现 curated catalog 与安全安装

**文件**

- 新增 `desktop-app/src/main/pluginCenter/RecommendedSkillsService.ts`
- 新增 `desktop-app/src/main/pluginCenter/RecommendedSkillsService.test.ts`
- `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- `desktop-app/src/main/index.ts`

**工作**

1. 给 `PluginCenterService` 注入 `codexHome` 与 `RecommendedSkillsService`；`index.ts` 复用已经用于 agent catalog 的 `resolveCodexHome(launch.env)`（`desktop-app/src/main/index.ts:190-212`）。
2. 推荐服务使用现有 `runGit`，不引入依赖；该封装已经提供参数数组、超时、输出上限和错误类型（`desktop-app/src/main/localGit/gitCli.ts:74-118`）。
3. 在 `$CODEX_HOME/vendor_imports/skills` 维护受控 sparse checkout：
   - 远端固定为 `https://github.com/openai/skills.git`，分支 `main`。
   - sparse paths 固定为 `skills/.curated`、`skills/.experimental`。
   - clone/fetch/reset/sparse-checkout 使用 30 秒超时；任何 reset 只能发生在验证过的受控 cache repo 内。
4. 使用 `$CODEX_HOME/vendor_imports/skills-curated-cache.json` 保存 `fetchedAt + skills`：10 分钟内直接读缓存，过期后刷新；刷新失败时返回旧缓存与 warning，没有缓存时返回空列表与 error。
5. 扫描两个 curated roots，解析 `SKILL.md` frontmatter 和可选 `agents/openai.yaml`；图标只允许解析为受控本地 media URL，缺失时由 renderer fallback；按显示名稳定排序并按 id 去重。
6. 安装时再次以服务端 catalog 查找 id/repoPath，不信任 renderer 回传路径；验证源路径位于受控 repo、目标位于 `$CODEX_HOME/skills`，目标已存在则返回 already-installed/overridden 而不覆盖。
7. 复制先写入同一目标根下的临时目录，完成后 rename 到最终目录；失败清理临时目录，不触碰最终目录。成功后让 `PluginCenterService` 失效 skills cache，并返回 `changedSections: ['skills']`。

**完成证据**：单测覆盖新 clone、fresh cache、stale refresh、网络失败回退、metadata/icon 解析、重复 id、路径穿越、已存在目标、复制失败回滚和成功安装。

### 步骤 4：贯通 IPC、preload 与 renderer resource

**文件**

- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts`
- `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.test.ts`
- `desktop-app/src/preload/pluginCenterBridge.ts`
- `desktop-app/src/preload/pluginCenterBridge.test.ts`
- `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.ts`
- `desktop-app/src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts`

**工作**

1. IPC handler 对 get/install 请求做 main-side schema parse，对返回值再次 parse，并复用现有的安全错误文案包装。
2. Preload bridge 对请求和响应做 jitless schema parse，不向 renderer 暴露 git、文件系统、Codex Home 或任意路径操作能力。
3. 为推荐技能新增独立 renderer resource map，按 API 实例缓存，5 分钟 fresh time，支持 stale-while-refresh、显式 retry、invalidate/release。
4. 推荐安装成功时只失效 recommended resource 与 skills supplemental resource；不重新加载插件 catalog，避免无关请求和页面闪烁。

**完成证据**：bridge/IPC/resource 测试验证 channel、payload、双端校验、同请求合流、fresh cache、force refresh、错误保留旧数据和 mutation 后失效。

### 步骤 5：重构技能浏览页面为“概览 + 分类”

**文件**

- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`
- 可选新增 `desktop-app/src/renderer/src/components/plugin-center/SkillBrowseRow.tsx`
- `desktop-app/src/renderer/src/components/plugin-center/PluginCard.tsx`（只做必要的可复用样式扩展，不改变插件卡默认外观）
- `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx`

**工作**

1. 根据当前 browse tab 选择 placeholder；技能页为“搜索技能”。
2. 将 `BrowseSkills` 拆为小型纯逻辑 helper 与展示组件：
   - `normalizeSkillMatchKeys`：规范化 id/name/display name/path 等匹配键。
   - `filterInstalledSkills`、`filterRecommendedSkills`、`skillsForCategory`。
   - `InstalledSkillsOverview`、`SkillCategoryTabs`、`SkillBrowseGrid`、`RecommendedSkillsState`。
3. 顶部“已安装”对搜索后的 installed 结果取前 6 项；余项生成前述摘要。无安装项时不渲染空网格，改为简短空状态。
4. Tabs 默认“个人”，分类值写回 `surface.category`；切换时保留 `surface.search` 并重置 scrollTop。
5. 为技能浏览使用专用 row：图标容器、标题/描述单行省略、整行打开预览；installed 右侧为勾选图标，recommended 右侧为“安装”按钮/Spinner。管理页继续使用 `OptimisticSkillSwitch`。
6. 推荐卡安装不再调用 `installSkillOwningPlugin`；改调 `installRecommendedSkill`。插件附带技能的原预览和安装所属插件能力继续保留在插件相关入口。
7. 分别渲染：skills loading、无任何已安装技能、当前搜索无结果、推荐加载、推荐无数据、推荐错误且无缓存、推荐 stale warning。
8. 保持 `lg:grid-cols-2`，窄窗口单列；为 Tabs、安装、重试、预览行添加明确的 aria label 和 focus ring。

**完成证据**：renderer 测试覆盖验收标准 1–8，并确认 PluginCard 原有插件样式断言不回归。

### 步骤 6：补齐不联网的 Electron E2E

**文件**

- `desktop-app/tests/e2e/plugin-center.e2e.ts`
- `desktop-app/tests/e2e/support/plugin-center-app-server.mjs`
- 必要时新增 `desktop-app/tests/e2e/fixtures/recommended-skills/`

**工作**

1. app-server fixture 返回 personal/repo、system 和 plugin scope 的多条已安装技能，数量至少 7 条，用于验证概览截断、summary 和分类。
2. 通过 `launchApp` 已有的 `configureCodexHome` 钩子预置 `$CODEX_HOME/vendor_imports/skills` 与包含多个推荐技能的 cache JSON，避免 E2E 访问 GitHub（`desktop-app/tests/e2e/support/app.ts:43-75`）。
3. E2E 断言：
   - “搜索技能”可见。
   - 已安装概览最多 6 项且有“另有 N 项”。
   - 个人/系统切换只显示对应技能。
   - 推荐分类显示预置 curated skill。
   - 搜索能过滤名称或描述。
   - 点击推荐安装后，磁盘目标创建，推荐项消失，个人/已安装出现该技能。
   - 420px 宽度无横向溢出。

**完成证据**：E2E 全程不访问公网，且安装断言同时验证 UI 与 Codex Home 文件结果。

### 步骤 7：回归验证与差异审查

按从小到大的顺序运行：

```bash
npm --prefix desktop-app run test:unit -- \
  src/shared/pluginCenterApi.test.ts \
  src/main/pluginCenter/RecommendedSkillsService.test.ts \
  src/main/pluginCenter/PluginCenterService.test.ts \
  src/main/pluginCenter/registerPluginCenterIpc.test.ts \
  src/preload/pluginCenterBridge.test.ts \
  src/renderer/src/components/plugin-center/pluginCenterDataResource.test.ts \
  src/renderer/src/components/plugin-center/PluginCenterPage.test.tsx

npm --prefix desktop-app run typecheck
npm --prefix desktop-app run lint
npm --prefix desktop-app run test:e2e -- --reporter=line tests/e2e/plugin-center.e2e.ts
```

最后检查：

1. `git diff --stat` 和 `git diff -- codex/codex-rs/app-server`，确保 app-server 无变更。
2. 对照附图检查标题、间距、搜索框、双列布局、勾选图标、分类 Tabs、长文本截断。
3. 检查没有把 API key、Codex Home 路径、git stderr 或完整本地路径返回 renderer。
4. 检查 staged/已有插件中心改动均被保留，没有回退用户现有实现。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 推荐源首次访问依赖 GitHub | 独立错误态与重试；测试全部使用预置缓存；成功获取后始终可回退旧缓存 |
| 当前 `recommended` 与 curated recommended 同名冲突 | browse 推荐只使用新 API；按参考实现的规范化 match keys 与已安装技能去重 |
| 安装路径带来目录穿越或覆盖风险 | renderer 不传任意目标；main 重新查 catalog、双重 containment 校验、拒绝覆盖、临时目录 + rename |
| 改 shared API 影响现有 bridge/mock | schema、IPC、preload、resource、renderer 和 E2E 同一提交更新；保留旧字段兼容 |
| PluginCard 样式调整影响插件 Tab | 优先新增 SkillBrowseRow；若扩展 PluginCard，只新增 opt-in variant 并保留默认测试 |
| 当前工作树已有大量插件中心改动 | 实现前逐文件读当前版本，以小 patch 叠加；不 checkout/reset，不覆盖无关 staged 内容 |

## 7. 完成条件

只有在以下条件全部满足时才视为完成：

- 12 条验收标准均由自动化测试或明确的视觉检查覆盖。
- 推荐技能是独立 curated catalog，并可安全安装为个人技能。
- 技能搜索、已安装概览、个人/系统/推荐分类与附图一致。
- 指定 unit、typecheck、lint、E2E 均通过，或任何无法运行项有具体阻塞证据。
- `codex/codex-rs/app-server/` 无变更，现有插件中心能力无回归。
