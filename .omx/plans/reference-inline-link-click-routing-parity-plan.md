# 参考项目内联链接点击路由复刻计划

日期：2026-08-23  
模式：`$plan` direct（只输出实施计划，不修改业务源码）  
前置计划：`.omx/plans/conversation-stream-resource-link-parity-plan.md`  
目标：在现有内联引用“已能识别、已能展示”的基础上，补齐点击后的统一分流，让不同链接按能力进入会话、右侧工作区文件、受控浏览器或安全的系统 fallback；同时明确哪些目标目前不存在，避免伪造可点击能力。

## 1. 结论先行

工作区模块**能承接本轮点击落点，但需要补一层统一分流，并放宽工作区浏览器的 HTTP 协议限制**。

- 会话跳转：已有完整能力，可直接复用。
- HTTP/HTTPS 工作区浏览器：浏览器主体能力已具备；当前只允许 HTTPS，本轮同时放宽为安全的 `http:`/`https:`。
- 当前项目内文件：已有安全的只读预览、文件树和多种媒体预览，本轮补齐点击接线与按行/范围定位。
- 项目外绝对路径、远端任务文件：当前工作区文件根只允许本地任务 cwd，不能直接内嵌打开；只能安全降级或保持展示态。
- 插件/应用内部导航：当前只有 catalog/身份数据，没有可导航的内部页面或 route，不能仅凭 `plugin://`、`app://` 造一个跳转。

本计划只交付一个闭环：会话、项目内文件只读预览/定位、目录文件树、HTTP/HTTPS 工作区浏览器和安全 fallback。文件编辑与写入不在本计划中。

## 2. 参考实现与当前实现的证据

### 2.1 参考项目真实行为

- 参考目录是发布包美化结果且没有 source map；以下调用链可作为运行行为证据，但压缩符号名不是可依赖的公开接口。实施测试必须在本项目自行建立，不假设参考包携带一方测试。
- 参考项目的 `DQ()` 按 app、plugin、agent、conversation、MCP resource、Sites、skill、file 分类，而不是把所有 token 都做成链接：`reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~artifact-tab-content.electron~app-main~pull-request-code-review~new-thread-pane~f023c15b-DuVw_8by.js:74576-74706`。
- 助手正文显式设置 `openFileLinksInSidePanel: true`：`reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~quick-chat-window-page~chatgpt-conversation-page-CrA1-JEm.js:227428-227490`。
- 文件 token 会携带 `line`、`column`、`endLine`，普通点击、双击、键盘操作和 modified click 最终进入统一的 `Qg()` 分流：参考 bundle `:73094-73296,73917-74250`。
- `Qg()` 会根据显式目标、内容类型、side panel 能力和 file manager fallback 选择落点：参考 bundle `:23523-23650`。
- 外链的普通点击进入统一 URL opener，并提供“内置浏览器 / 外部浏览器 / 复制链接”的上下文菜单：参考 bundle `:71117-71314`。
- conversation/thread token 在有 resolver 时调用内部会话导航：参考 bundle `:71729-71755,74541-74569`。
- plugin 和 agent 只有在真实目标可解析时才变成按钮；无目标时保持展示态：参考 bundle `:73655-73863,73864-73915`。
- app、MCP resource、Sites 在 `DQ()` 主分支中默认是语义展示，不应为了“看起来完整”而伪造点击动作：参考 bundle `:73567-73654,74614-74627,74652-74657`。

### 2.2 当前项目事实

- 当前 `InlineReference` 已完成识别与展示，但 action context 只暴露本地路径、会话和外链三个入口：`desktop-app/src/renderer/src/components/render-units/inlineReference.tsx:30-35`。
- 本地文件/目录点击仍直接调用 `window.desktopApp.codex.openLocalPath()`，没有进入右侧工作区：`desktop-app/src/renderer/src/components/render-units/inlineReference.tsx:279-318`。
- 外链仍直接调用系统外部浏览器：`desktop-app/src/renderer/src/App.tsx:2858-2899`。
- end-resource 卡片已经存在可复用的正确模式：优先 `workspace.openFile/openBrowser`，失败后才走系统打开：`desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx:1149-1201`。
- `RightWorkspaceProvider` 已经在会话渲染树外层，并暴露 `openBrowser()`、`openFile()`：`desktop-app/src/renderer/src/App.tsx:744-802`、`desktop-app/src/renderer/src/components/right-workspace/RightWorkspaceProvider.tsx:18-32,74-102`。
- 工作区文件 target 目前只有 `relativePath/title`，没有行、列、范围或目录选中信息：`desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts:5-35`。
- 文件工作区明确标记为“只读预览”，并已支持 Markdown、代码、PDF、图片、过大/不支持文件 fallback：`desktop-app/src/renderer/src/components/right-workspace/files/FileWorkspace.tsx:256-314,515-607`。
- 文件路径契约只允许规范化的工作区相对路径；main 端文件根只接受本地任务 cwd：`desktop-app/src/shared/fileWorkspaceApi.ts:14-35`、`desktop-app/src/main/rightWorkspace/registerRightWorkspaceIpc.ts:121-138`。
- 受控浏览器支持真实导航，但当前 URL 归一化、共享 schema 和 main allowlist 都只允许 HTTPS/about:blank，拒绝普通 HTTP：`desktop-app/src/renderer/src/components/right-workspace/browser/BrowserWorkspace.tsx:239-247`、`desktop-app/src/shared/browserWorkspaceApi.ts:8-15`、`desktop-app/src/main/rightWorkspace/BrowserWorkspaceService.ts:324-337`。
- composer catalog 已有 chat/liveAgent/skill/plugin/app 的真实元数据，但当前 identity index 只保留 app/plugin 的展示身份，没有保留可用于点击的 threadId/skill path：`desktop-app/src/shared/composerContext.ts:28-91`、`desktop-app/src/renderer/src/composer/composerContextIdentity.tsx:8-63`。
- 现有会话跳转已通过 `openConversation({ conversationId })` 进入统一会话打开流程：`desktop-app/src/renderer/src/App.tsx:697-702`。
- 当前 `localPathOpen` 虽接收 `line`，最终只是 Electron shell 打开路径，行号没有被消费：`desktop-app/src/main/localPathOpen.ts:12-19,36-56`。

## 3. 能力审计矩阵

| 内联目标 | 参考行为 | 当前可用落点 | 是否满足 | 本计划动作 |
| --- | --- | --- | --- | --- |
| `thread://` / conversation | 内部会话跳转 | 现有 `openConversation` | 满足 | 复用，不新建导航系统 |
| 可解析 `agent://` live agent | 进入对应子会话 | catalog 有 `threadId`，当前点击 index 丢失该信息 | 部分满足 | 扩展 renderer identity/resolver，解析成功才可点 |
| `subagent://` configured agent | 无真实会话时展示 | 只有角色定义，没有目标会话 | 满足展示态 | 保持不可点击 |
| 项目内文件 | side panel 文件目标 | 右侧工作区只读预览 | 部分满足 | 进入预览；增加行/范围定位 |
| 项目内目录 | file manager / explorer | Files 工作区有文件树，但 open target 无 reveal/select | 部分满足 | 增加目录 target 或 explorer reveal 状态 |
| 文件行/列/范围 | 打开并定位 | classifier 只有 `line`；workspace target 无定位 | 不满足 | 扩 descriptor 和 workspace target；预览后滚动并高亮 |
| 项目外绝对路径 / global skill | 可选择 side panel 或系统 target | workspace root 只允许 cwd；系统打开可用 | 仅 fallback | 不绕过 root；安全系统打开或展示态 |
| 远端任务文件 | host-aware file target | Files workspace 明确只支持 local cwd | 不满足 | 保持展示态/既有远端能力；本计划不伪造本地打开 |
| `https://` | 受控浏览器 | workspace browser 完整 | 满足 | 普通点击进入工作区浏览器 |
| `http://` | 受控浏览器 | 当前 URL 策略拒绝 HTTP | 部分满足 | 放宽 browser URL 契约后进入工作区浏览器 |
| `plugin://` | 有内部 path 才跳转 | catalog 有身份，无内部页面/route | 不满足 | 保持展示态，直到真实 route 出现 |
| `app://` | 默认展示 | 只有 catalog 身份 | 满足展示态 | 不新增点击 |
| `mcp-resource://` | 默认展示 token | 已有 token/card | 满足展示态 | 不新增点击 |
| `sites-project://` | 默认展示 token | 无 Sites 内页 | 满足展示态 | 不新增点击 |
| `$skill` | 已解析 skill 文件可进 side panel | catalog 有 path；workspace 只接受 cwd 内文件 | 部分满足 | cwd 内进预览；cwd 外安全 fallback/展示 |

## 4. 需求边界

### 4.1 本计划主交付必须包含

- 所有内联引用点击先经过一个统一的 renderer action resolver，不能继续把 `openLocalPath`、`openExternalHttpUrl` 分散在 token 组件内。
- 项目内文件优先进入右侧工作区；项目内目录进入 Files explorer 并定位到目录。
- 支持文件定位元数据透传：至少 `line`，并为 `column/endLine` 留下完整契约；不能继续把行号交给不会消费它的 shell API。
- HTTP 和 HTTPS 普通点击都进入右侧工作区浏览器，不再按协议分流到系统浏览器。
- 工作区浏览器 URL allowlist 从 `https:` 扩为 `http:`/`https:`；`about:blank` 继续只用于空白页，其他 scheme 仍拒绝。
- conversation 和可解析 live agent 进入现有会话打开流程。
- app、MCP、Sites、configured agent、无内部 route 的 plugin 保持展示态。
- skill 只有在 catalog 能解析真实 path 后才可操作；cwd 内走工作区，cwd 外不突破工作区根。
- 保留系统打开作为明确 fallback，不把 fallback 当首选路径。
- 不修改 `codex/codex-rs/app-server/`，也不新增 provider/app-server 协议字段。

### 4.2 本计划主交付不包含

- 新建插件中心、应用详情页、MCP resource viewer 或 Sites 页面。
- 放宽受控浏览器到 `http:`/`https:` 之外的任意 scheme。
- 让远端任务路径伪装成本地路径。
- 文件编辑、保存或任何写入能力；文件工作区继续保持只读预览。
- 修改 Codex app server。

## 5. 推荐设计

```text
Markdown / inline code
  -> 现有 classifyReferenceTarget()
  -> 新增 resolveInlineReferenceAction(descriptor, capabilities, catalog)
  -> 纯 action union
       -> workspace-file / workspace-folder
       -> workspace-browser
       -> conversation
       -> system-file fallback / explicit external-browser action
       -> display-only
  -> 单一 executeInlineReferenceAction() 适配现有 workspace / conversation / preload API
```

新增 action 必须是纯数据，不把闭包和 Electron API 混进 classifier：

```ts
type InlineReferenceAction =
  | { type: 'workspace-file'; relativePath: string; line?: number; column?: number; endLine?: number; mode: 'preview' | 'pinned' }
  | { type: 'workspace-folder'; relativePath: string }
  | { type: 'workspace-browser'; url: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'system-file'; path: string; cwd?: string; line?: number }
  | { type: 'external-browser'; url: string }
  | { type: 'display-only'; reason: string }
```

核心原则：

- classifier 只回答“它是什么”；action resolver 回答“当前环境能去哪里”；executor 才执行副作用。
- 工作区相对路径转换必须使用共享的、可单测的 POSIX/Windows 归一化 helper；renderer 只能提出候选，main/FileWorkspaceService 仍是最终 containment 边界。
- 同一文件的单击使用 preview tab，双击或明确 modified action 使用 pinned tab；复用已有 `WorkspaceOpenMode`，不另造 tab 状态。
- semantic resolver 复用 composer catalog 已加载数据，不为每个 token 单独发 IPC 请求。
- 安全的 `http:`/`https:` 普通点击统一解析为 `workspace-browser`；`external-browser` 只保留给明确的“在外部浏览器打开”动作，不作为 HTTP 默认 fallback。
- `InlineReference` 只在 action 不是 `display-only` 时渲染 button/link 语义。

## 6. 可测试验收标准

| 编号 | 验收结果 | 自动化证据 |
| --- | --- | --- |
| C1 | 助手 Markdown 中 `https://example.test/docs` 和 `http://example.test/docs` 普通点击都创建并激活右侧 browser tab，均不调用 `openExternalHttpUrl`。 | production Streamdown integration + workspace dispatch spy。 |
| C2 | 工作区浏览器可创建、导航和恢复 HTTP/HTTPS URL；`javascript:`、`data:`、`file:`、未知 scheme 仍被 shared schema、renderer 和 main 三层拒绝。 | browser schema/service tests + action resolver handler spies。 |
| C3 | `./src/App.tsx:42` 和绝对路径但位于当前 cwd 内的文件，点击后打开同一个 workspace-relative file tab，并把 line 42 传到 tab props；不调用 `openLocalPath`。 | POSIX/Windows path matrix + workspace descriptor test。 |
| C4 | 代码预览完成后自动滚动到目标行并高亮目标行/范围；目标超过文件长度时 clamp 且不抛错；切换到无定位的同一文件时清除旧高亮。 | `FileWorkspace`/`CodePreview` component tests。 |
| C5 | `src/components/` 点击后打开 Files explorer、展开并选中对应目录；目录不存在或目标其实是文件时给出受控错误，不调用 shell。 | Files tree integration tests。 |
| C6 | cwd 外绝对路径、越界相对路径、符号链接逃逸、remote task、无 cwd 都不会进入 workspace 文件 API；仅在现有本地 capability 允许时走系统 fallback，否则展示态。 | pure resolver + FileWorkspaceService negative tests。 |
| C7 | `thread://known` 和 `chatgpt-conversation://known` 调用现有 `openConversation`；可解析 `agent://` 使用 catalog 中真实 threadId；`subagent://` 和未知 agent 零导航。 | identity index + InlineReference tests。 |
| C8 | `$skill` 对应 path 位于当前 cwd 时打开 `SKILL.md` workspace 预览；cwd 外 skill 不突破 root；未知 skill 展示但不可点击。 | catalog resolver fixture + path containment matrix。 |
| C9 | `plugin://` 只有在未来存在明确内部 route resolver 时才可点击；当前 app/plugin/MCP/Sites/configured agent 的测试全部断言无 button role、无 handler 调用。 | exhaustive semantic-kind component test。 |
| C10 | 单击文件使用 preview tab，双击固定 tab；Enter 等价单击、Space 等价按钮激活；展示型 token 不进入 Tab 序列。 | keyboard/mouse component tests。 |
| C11 | 现有 end-resource 卡片与内联链接共享 action resolver 后行为一致：workspace 可用时优先内部打开，fallback 条件一致。 | `renderUnitDetails` regression tests。 |
| C12 | 历史消息、流式消息完成前后、重新打开任务三种路径执行相同 action；不会因为 streaming 重渲染重复打开目标。 | `App.test.tsx` + E2E reopen/streaming fixture。 |
| C13 | 实现 diff 不包含 `codex/codex-rs/app-server/` 或 provider 协议变更。 | `git diff --name-only` 审核。 |
| C14 | 文件工作区继续明确显示“只读预览”，本轮 diff 不新增文件写入 API 或保存控件。 | FileWorkspace UI test + `git diff --name-only`/API type audit。 |

## 7. 实施步骤

### 0) 冻结当前行为和参考 fixture

- 在现有 `referenceInlineTarget.test.ts`、`inlineReference.test.tsx`、`inlineReference.streamdown.test.tsx` 中补充点击分流基线，先锁定当前会话/文件/外链行为。
- 从参考 `DQ/dQ/Qg` 提取最小 fixture 表：输入 href/label、期望 kind、是否可交互、目标 action、参考行号。
- 给 `renderUnitDetails` 的现有 workspace-first 行为补回归断言，后续统一 resolver 时防止资源卡片退回系统打开。

### 1) 新增纯 action resolver

- 新建 `desktop-app/src/renderer/src/lib/referenceInlineAction.ts`，定义 `InlineReferenceAction`、capability 输入和 `resolveInlineReferenceAction()`。
- 复用 `referenceInlineTarget.ts` 的 descriptor，不重复 URI 分类。
- 将“路径是否位于当前 cwd”“绝对路径转 workspace-relative”“Windows/POSIX”“remote/local”“HTTP/HTTPS 统一进 workspace browser”写成 table-driven 纯函数测试。
- 扩展 `LocalInlineReference` 的定位 metadata，按第 0 步冻结的参考 fixture 支持 `line/column/endLine`；先从参考真实格式取证，不自行发明新的链接语法。
- `display-only` 必须携带稳定 reason，便于测试和后续 telemetry；reason 不直接向用户暴露技术错误。

### 2) 补齐 semantic 目标解析

- 扩展 `composerContextIdentity.tsx`，保留 catalog 中与点击相关的最小原始 metadata：chat/liveAgent 的 threadId、skill 的 path、plugin/app 的 canonical identity。
- 不改变 composer mention 的提交格式，也不新增 catalog IPC；直接复用 `useComposerContextCatalog()` 已加载数据。
- conversation descriptor 自带 targetId 时优先使用它；agent/skill 只通过 exact URI/canonicalId 命中 catalog，不按 label 猜目标。
- plugin/app 暂无内部 route 时 resolver 明确返回 `display-only`。

### 3) 扩展右侧工作区打开契约

- 将 `RightWorkspaceProvider.openFile(relativePath, title)` 改为接收结构化 target/options，至少支持 `line/column/endLine/mode`。
- 扩 `WorkspaceOpenTarget.file` 与持久化 tab props，保留稳定的 `file:${relativePath}` tab id；定位信息不应生成重复文件 tab。
- 新增 folder/explorer reveal target，或给 Files explorer props 增加 `revealPath`；目录点击不得伪装成文件预览。
- 对旧持久化 workspace state 做兼容解析：缺少新字段时按无定位打开；非法/越界行号丢弃而不是使 tab 恢复失败。

### 4) 放宽工作区浏览器到 HTTP/HTTPS

- 将 `BrowserWorkspace.tsx` 的 `normalizeHttpsUrl()` 改为协议明确的 `normalizeBrowserUrl()`，只接受 `http:`/`https:`；空输入仍按现有规则补 `https://`。
- 将 `browserWorkspaceApi.ts` 的 URL schema 从 HTTPS-only 扩为 HTTP/HTTPS/about:blank，错误文案与类型测试同步更新。
- 将 `BrowserWorkspaceService.isAllowedAppUrl()` 和导航校验扩为 `http:`/`https:`；HTTP 与 HTTPS 之间的重定向继续留在同一工作区 browser view，其他 scheme 仍阻止。
- 保留现有 `contextIsolation`、sandbox、webSecurity、权限拒绝、下载限制、证书错误处理和弹窗拦截；本轮只调整 URL scheme allowlist，不降低其他浏览器隔离。
- `window.open`/新窗口继续拒绝创建未受控窗口；显式“外部浏览器打开”仍可走系统 API，但普通内联 HTTP/HTTPS 点击不得使用该 fallback。
- 增加 HTTP 初始 URL、HTTP 页面内导航、HTTPS↔HTTP 重定向、非 HTTP(S) 阻断和任务恢复测试。

### 5) 在只读预览中实现按行/范围定位

- `FileWorkspace` 将 tab 的定位信息传到 `FilePreview/CodePreview`。
- 现有依赖 `@pierre/diffs@1.2.12` 已提供 `CodeView` ref 的 `scrollTo({ type: 'line' | 'range' })` 和 selected-lines 能力；把单文件代码预览从无 handle 的 `PierreFile` 调整为单 item `CodeView`，复用依赖，不新增第三方包。
- highlighter ready 且内容完成读取后执行一次定位；文件/line/range 变化时重新定位，卸载时不残留 selection。
- Markdown、PDF、图片不伪造代码行定位；有 line 的 Markdown 可先回落到原始代码视图或明确不支持提示，实施时用 fixture 固定选择，不能静默忽略。
- fallback `<pre>` 路径也要有稳定的行 anchor/scroll 行为，确保 highlighter 加载失败时仍能定位。

### 6) 接入统一 executor

- 在 `AssistantText` 所在 provider 树中构建稳定的 action executor；使用 `useOptionalRightWorkspace()`、现有 `onOpenConversation` 和 preload API。
- `InlineReferenceContext` 收敛为单一 `resolve/execute` 接口；token 组件不再直接调用 Electron API。
- workspace action：文件/目录/HTTP/HTTPS 工作区浏览器。
- internal action：conversation/live agent。
- fallback action：cwd 外本地文件走现有 `openLocalPath`；外部浏览器只响应明确的 alternate action，不接管普通 HTTP/HTTPS 点击。
- 系统文件 fallback 只保证安全打开文件；现有 shell API 不消费行号，因此不得在 UI 或测试中宣称它支持定位。
- end-resource 的 `ResourceCard` 改为复用同一 executor 或同一纯 resolver，避免两套优先级漂移。

### 7) 补齐鼠标、键盘和 tab 模式

- 文件单击打开 preview；双击固定为 pinned。若双击会触发两次单击，使用稳定的 workspace replace/pin 语义保证最终只有一个 tab。
- Enter/Space 遵守原生 button 语义；外链保留标准 `<a>` 和 modified click 的合理行为。
- display-only token 保持 `<span>`，不设置 `role="button"`/`tabIndex=0`。
- 上下文菜单若本轮实现，只允许复用现有动作：“工作区打开 / 系统打开 / 文件管理器显示 / 复制链接”；没有真实动作的菜单项不显示。上下文菜单不是 C1-C14 主交付的阻塞项。

### 8) 分层验证

- 单元：classifier/action resolver/path matrix/catalog resolver/workspace descriptor。
- 组件：InlineReference 语义、FileWorkspace 定位、folder reveal、preview/pinned、零副作用展示态。
- 集成：真实 Streamdown Markdown 输入，不只测试手写 descriptor；覆盖 streaming 和 history。
- E2E：从真实 assistant 消息点击文件、会话、HTTP 和 HTTPS，观察右侧 tab/会话切换；覆盖任务 reopen。
- 安全：HTTP/HTTPS allowlist、危险 scheme、越界路径、symlink escape、remote task。
- 全量：typecheck、lint、unit、目标 E2E。

## 8. 建议修改文件

主交付预计涉及：

- `desktop-app/src/renderer/src/lib/referenceInlineTarget.ts`
- `desktop-app/src/renderer/src/lib/referenceInlineAction.ts`（新增）
- `desktop-app/src/renderer/src/composer/composerContextIdentity.tsx`
- `desktop-app/src/renderer/src/components/render-units/inlineReference.tsx`
- `desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx`
- `desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts`
- `desktop-app/src/renderer/src/components/workspace-container/workspaceTypes.ts`
- `desktop-app/src/renderer/src/components/right-workspace/RightWorkspaceProvider.tsx`
- `desktop-app/src/renderer/src/components/right-workspace/browser/BrowserWorkspace.tsx`
- `desktop-app/src/renderer/src/components/right-workspace/files/FileWorkspace.tsx`
- `desktop-app/src/shared/browserWorkspaceApi.ts`
- `desktop-app/src/main/rightWorkspace/BrowserWorkspaceService.ts`
- `desktop-app/src/renderer/src/App.tsx`
- 对应 unit/integration/E2E tests。

主交付原则上不需要修改：

- `desktop-app/vendors/ai-sdk-provider-codex-asp/`
- `codex/codex-rs/app-server/`
- admin backend。

## 9. 验证命令

实施时先跑目标测试，再跑全量验证：

```bash
npm --prefix desktop-app run test:unit -- src/renderer/src/lib/referenceInlineTarget.test.ts src/renderer/src/lib/referenceInlineAction.test.ts src/renderer/src/composer/composerContextIdentity.test.ts src/renderer/src/components/render-units/inlineReference.test.tsx src/renderer/src/components/render-units/inlineReference.streamdown.test.tsx src/renderer/src/components/right-workspace/browser/BrowserWorkspace.test.tsx src/renderer/src/components/right-workspace/files/FileWorkspace.test.tsx src/renderer/src/components/workspace-container/workspaceOpenTargets.test.ts src/main/rightWorkspace/BrowserWorkspaceService.test.ts src/shared/browserWorkspaceApi.test.ts src/renderer/src/App.test.tsx
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run lint
npm --prefix desktop-app run test:unit
npm --prefix desktop-app run test:e2e -- tests/e2e/render-units.e2e.ts --reporter=line
git diff --name-only
```

## 10. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 为了复刻点击，顺手扩展文件写入。 | 本轮文件工作区保持只读，只改打开目标与定位。 |
| 绝对路径直接进入工作区，突破 cwd root。 | renderer 只做候选转换，shared schema + FileWorkspaceService 继续做最终 containment。 |
| 行号被写进 tab props，但预览根本不滚动。 | C4 必须在真实 CodeView/fallback DOM 上断言 scroll 与 selection。 |
| plugin/app 看起来像链接却没有真实页面。 | resolver 返回 `display-only`；没有 route 就没有 button。 |
| 放开 HTTP 后误放开 `file:`、`javascript:` 等危险 scheme。 | shared schema、renderer normalizer、main allowlist 三层都只允许 `http:`/`https:`/内部空白页，并覆盖负向测试。 |
| HTTP 页面降低传输安全性。 | 地址栏保留完整协议展示；不伪装安全状态，现有 sandbox、权限、下载、弹窗和导航隔离继续生效。 |
| catalog 尚未加载时 token 先不可点，加载后状态错误。 | identity index 支持异步更新；组件测试覆盖 loading -> resolved。 |
| 资源卡片和内联 token 的优先级再次分叉。 | 共用纯 action resolver/executor，保留两种展示组件。 |
| preview/pinned 恢复后重复 tab 或旧 line 高亮残留。 | 文件 tab id 只基于 relativePath；定位是 props/runtime，不参与 id；切换时清理 selection。 |
| 文件内容在定位前发生变化。 | clamp 行范围；watcher refresh 后重新应用当前定位一次。 |

## 11. 完成定义

本计划主交付在 C1-C14 全部通过、全量 typecheck/lint/unit 和目标 E2E 通过、且 diff 未触碰 app-server 后完成。此时可以对外描述为：

> 内联链接已能按类型进入会话、项目内文件只读预览/定位、目录文件树或 HTTP/HTTPS 工作区浏览器，并在能力不足时安全降级。
