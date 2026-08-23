# 对话流内联链接参考能力复刻计划

日期：2026-08-22
模式：`$plan` direct（根据代码审查结论修订；本计划只定义实施方案，不修改应用源码）
目标：复刻参考项目在**助手会话流**中的内联链接、文件引用和语义 token 行为。行为与数据链以参考项目真实 Markdown renderer 为准；附图要求的浅蓝色、hover/focus dotted underline 与上方浅灰 Tooltip 属于本项目明确的视觉覆盖，不冒充参考 bundle 的原始样式。

## 1. 需求摘要与边界

### 1.1 参考实现的真实主链路

参考项目的助手输出不是依赖一组必须由 provider 传输的 structured inline parts。真实主链路是：

```text
assistant Markdown text
  -> Markdown <a> renderer
  -> DQ(href, label) target classifier
  -> file / skill / plugin / agent / conversation / app / resource / Sites token
  -> 无语义命中时回落到普通 Markdown link
```

- `DQ()` 根据 `href + label` 分类 app、plugin、agent、MCP resource、ChatGPT conversation、Sites project、skill、文本/文件路径：`reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~artifact-tab-content.electron~app-main~pull-request-code-review~new-thread-pane~f023c15b-DuVw_8by.js:74576-74706`。
- Markdown `<a>` 的真实接入点调用 `DQ()`，未命中才渲染普通外链：同文件 `:100164-100194`。
- inline code 也会识别 `@path`、Markdown-style link、skill 等内容并复用 `DQ()`：同文件 `:97891-97941`。
- 文件 token 使用 `sQ/dQ` 处理图标、Tooltip、键盘和打开动作：同文件 `:73094-73296,73917-74250`。
- 文件图标选择器按目录、特定文件名、扩展名和 MIME fallback 分类：同文件 `:47571-47753`。

`chatgpt-conversation-page-CrA1-JEm.js:150347-150849` 中的 `CI`、mention node 和 `richLink` 是 composer/ProseMirror schema 的证据，不是助手消息 transport schema。其序列化逻辑会把节点写回 Markdown 风格链接（同文件 `:138968-139024`），因此本计划不再据此要求新增 app-server/provider structured part。

### 1.2 当前项目事实

- 助手正文最终经 `desktop-app/src/renderer/src/App.tsx:2673-2681` 进入 `App.tsx:2858-2899` 的 Streamdown。
- `streamdown@2.5.0` 支持 `components.a`、自定义 HAST tag renderer 和 `components.inlineCode` 覆盖：`desktop-app/node_modules/streamdown/dist/index.d.ts:59-76`。由于 `components.inlineCode` 是全量替换入口，本项目不使用它承载选择性引用增强，避免普通 inline code 脱离 Streamdown 默认 renderer。
- 历史 `agentMessage` 当前映射为文本：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/history-mapper.ts:126-131,314-332`。
- 实时 `agentMessage` 当前产生 `text-start/text-delta/text-end`：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/event-mapper.ts:622-631,692-725,762-790`。
- 当前生成的 `ThreadItem.agentMessage` 只有 `id/text/phase/memoryCitation` 等字段：`desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/app-server-protocol/v2/ThreadItem.ts:30`。
- `resourceFileIcon.tsx:61-214` 已有较完整的文件类型判定基础，但 `:162-186` 将多个参考图标折叠为通用 Lucide 图标；“分类相同”不等于“图形视觉相同”。
- 当前 IPC/API 主要覆盖本地路径、HTTP URL 和已有 conversation 导航能力：`desktop-app/src/shared/codexIpcApi.ts:677-695`。不能假设 skill/app/plugin/resource/Sites 已存在可调用 resolver。
- `localPathOpen.ts:36-56` 只对相对路径执行 cwd resolve/containment；绝对路径需要由 renderer capability、会话来源和 main 端路径策略共同约束，不能描述成“所有路径都 cwd-contained”。
- `AGENTS.md` 禁止修改 codex app-server 代码；本计划只允许修改 desktop renderer、共享 IPC 契约中确有必要的安全接口、provider fork 和测试，并优先避免协议扩展。

### 1.3 范围

必须覆盖：

- 普通 `http(s)` Markdown 链接；
- POSIX/Windows 本地路径、`file://`、目录、可选行号；
- 参考 `DQ()` 能识别的 skill、plugin、agent、conversation、app、MCP resource、Sites project href；
- Markdown `<a>` 与选择性 inline-code decoration 两条入口；普通 inline code 和 fenced code block 必须完全保持 Streamdown 原生渲染；
- 文件类型图标分类和视觉映射；
- Tooltip、键盘、焦点、hover、流式更新、历史恢复和安全降级；
- 现有 MCP `resource_link` 卡片及 end-resource 派生行为不回归。

不在本轮范围：

- 为当前 app-server 未提供的数据发明协议字段；
- 把 composer 的 `richLink` node 当成独立助手消息类型；普通 rich URL 继续走 Markdown 外链 fallback；
- 为展示型 token 伪造点击动作；
- 直接复制参考项目二进制或静态资产；
- 修改 codex app-server 实现。

## 2. 关键决策

### 2.1 主路径与增强路径

主路径固定为：

```text
history/live assistant text
  -> Streamdown a override + selective inline-code rehype marker
  -> classifyReferenceTarget(rawHref, label, inlineText)
  -> internal InlineReferenceDescriptor
  -> InlineReference renderer
```

inline code 路径只允许增强明确命中的 `@path`、Markdown-style reference 和 skill：rehype 插件在 sanitize/harden 后检查非 `pre > code` 节点，命中后改写为专用 tag，再由专用 component 渲染 `InlineReference`。未命中的 inline code 不改 tag、不进入自定义 component，因此继续由 Streamdown 默认 renderer 负责。

`InlineReferenceDescriptor` 只是 renderer 内部的 discriminated union，不是新的 app-server/provider message part。只有当当前协议已经真实携带结构化数据时，才允许增加独立 normalizer 作为增强输入；增强输入必须归一化到同一个内部 descriptor，不能成为完成本计划的前提。

### 2.2 类型与交互矩阵

| 内部类型 | 识别来源 | 参考行为/本项目契约 | 无 resolver 或无 capability 时 |
| --- | --- | --- | --- |
| `local-file` / `local-folder` | path、`file://`、参考 file matcher、inline code `@path` | 通过 `ResourceFileIcon` 展示；满足本地能力与路径策略时可打开 | 展示 token，不设置 clickable role |
| `external-url` | 安全的 `http(s)` href | 普通 `<a>` 或现有 workspace browser；保留用户 label | 不支持协议回落为安全文本 |
| `skill` | `DQ()` 的 skill matcher | 能解析为已知本地 skill/path 时可打开 | 展示 skill token |
| `plugin` | `DQ()` 的 plugin matcher | 已注册且存在明确内部导航时可交互 | 展示 plugin token |
| `agent` | `DQ()` 的 agent matcher | 存在 thread/conversation resolver 时可交互 | 展示 agent token或按参考 matcher 回落 |
| `conversation` | `DQ()` 的 conversation matcher | conversation id 可解析且目标存在时导航 | 展示 conversation token |
| `app` | `DQ()` 的 app matcher | 默认展示语义 token/icon；仅已有明确内部 resolver 时可交互 | 展示 app token |
| `mcp-resource` | `DQ()` 的 MCP resource matcher、现有 `resource_link` | 参考实现默认是展示型 token；MCP 卡片保持当前可读布局 | 不伪造点击能力 |
| `sites-project` | `DQ()` 的 Sites matcher | 参考实现默认是展示型 token | 不伪造点击能力 |
| `unsupported` | 未知或危险 scheme、无法安全解析的输入 | 保留可复制文本，不导航、不发 IPC | 同左 |

交互性必须由 `descriptor.kind + resolver availability + capability` 共同决定，不能仅凭 custom URI 的存在决定。

### 2.3 视觉契约

- 行为、类型和交互性严格以参考 renderer 为基准。
- 参考 inline shell `lZ` 实际使用 dashed、约 `0.5px`、offset 2：参考 bundle `:72843-72931`。
- 本项目按附图有意覆盖为：深色主题浅蓝文字、静止无下划线、hover/focus-visible dotted underline、`underline-offset-4`、上方浅灰 Tooltip。测试与文档均标记为“产品视觉覆盖”，不再引用无关的 safety “Learn more” 链接作为参考证据。
- Tooltip 使用现有 Radix/shadcn `Tooltip`，展示型 token 可以提供 Tooltip，但不得因此获得 button/link 语义。

## 3. 可测试验收标准

| 编号 | 验收结果 | 自动化证据 |
| --- | --- | --- |
| A1 | 历史 `agentMessage.text` 和实时 text delta 中的同一 Markdown custom URI 都经过生产 `components.a` 路径得到相同 token；重新打开任务后结果不变。 | history-mapper/event-mapper fixture + `App.test.tsx` integration + E2E reopen。 |
| A2 | 从参考 `DQ()` 提取的 app/plugin/agent/MCP resource/conversation/Sites/skill/file fixture 全部有显式分类结果；安全 `http(s)` 未命中时回落为普通外链。 | table-driven classifier test，fixture 注明参考 bundle 分支行号。 |
| A3 | inline code 中的 `@path`、Markdown-style link 和 skill 仅在命中时转为 `InlineReference`；普通 inline code 的 DOM、class 和 `data-streamdown` 属性与未启用增强的 Streamdown 完全一致；fenced code block 不参与识别；inline code 不生成 end-resource 卡片。 | inline-code parser + selective rehype integration + baseline DOM parity + code-block/end-resource regression。 |
| A4 | 第 2.2 节每个类型严格执行交互矩阵：file/skill/plugin/agent/conversation 仅在 resolver/capability 存在时可操作；app/MCP resource/Sites 默认不伪造点击。 | exhaustive switch + role/tabIndex/handler/resolver assertions。 |
| A5 | `javascript:`、`data:`、未知 custom scheme、畸形编码、越界 relative path、远端会话本地路径均零副作用；允许的语义 custom URI 只进入内部分类器，绝不直接交给 shell。 | parser、URL transform、IPC/handler negative tests。 |
| A6 | 相对路径按 cwd resolve 并 containment；绝对路径和 `file://` 只有在 `canOpenLocalPaths` 且会话来源允许时才激活；行号被安全解析并传递。 | POSIX/Windows/path traversal/capability matrix tests。 |
| A7 | 参考文件名、扩展名和 MIME fixture 得到相同 file kind；每个 reference kind 还有对应 icon component/snapshot，不能只断言 `data-file-icon`。 | pure helper parity table + icon render snapshot/visual assertions。 |
| A8 | 产品视觉覆盖在 light/dark 下均满足 token 色、dotted underline、offset 4、focus-visible、cursor 和对比度要求；disabled token 无交互 cursor/underline。 | class/token unit tests + Playwright computed style/screenshot。 |
| A9 | hover 和 keyboard focus 在上方显示完整安全值的浅灰 Tooltip；可换行、箭头同色、离开/失焦关闭；展示型 token 不因 Tooltip 变成按钮。 | `role="tooltip"` unit + keyboard E2E。 |
| A10 | MCP `resource_link` 保持可读卡片，复用分类/icon helper 但遵循展示型语义；`app://` 或无 resolver 不会触发外部打开。 | `renderUnitDetails` regression + handler spy 零调用。 |
| A11 | 普通 Markdown、代码块、数学、Mermaid、CJK、composer mention 提交、资源排序和 end-resource 卡片均无回归。 | 现有 suites + targeted regression。 |
| A12 | 完成实现不依赖新增 app-server 字段，也不修改 codex app-server；若发现真实结构化字段，必须单独记录来源并提供向后兼容文本 fallback。 | diff review + generated protocol/provider compatibility test。 |

## 4. 实施步骤

### 0) 冻结参考 fixture 和当前行为

- 从参考 `DQ()` 的每个分支提取最小 `href + label -> kind` fixture，并记录分支行号；不要从 composer node 名称反推 URI 格式。
- 从参考 `oJe()` 提取 inline-code fixture，从 `Fz()` 提取 filename/extension/MIME fixture。
- 为当前 `AssistantText`、provider history/live text、end-resource 和 MCP `resource_link` 补回归测试，先证明修改前的数据形态与行为。
- 输出 fixture 审计表：输入、期望 kind、是否可交互、需要的 resolver、fallback、参考行号。

### 1) 建立纯分类与安全转换层

- 新增 `desktop-app/src/renderer/src/lib/referenceInlineTarget.ts`，实现 `classifyReferenceTarget({ href, label, inlineText })`。匹配顺序与参考 `DQ()` 保持一致，返回 renderer 内部 `InlineReferenceDescriptor`。
- 将本地路径、`file://`、Windows/POSIX、`:line` 解析与 reference semantic URI 分类分离，避免路径启发式吞掉 app/plugin/agent 等 URI。
- 明确 Streamdown URL preservation 策略：仅保留从参考 fixture 得到的语义 scheme，并在 renderer 内部消费；`javascript:`、`data:`、畸形 URI 和未知 scheme 不进入 DOM href，也不进入 shell。为 `urlTransform` 或等价 hook 写独立测试。
- 新增纯 inline-code decoration helper，识别参考 `oJe()` 覆盖的 `@path`、Markdown-style link 和 skill。
- 新增选择性 rehype 插件：只检查非代码块的 inline `code` 节点，命中 helper 时改写为专用 reference tag；未命中节点保持原始 `code` tag，不得接入全量 `components.inlineCode` override。
- 若现有 `assistantRenderUnits.ts` 与 `renderUnitDetails.tsx` 有重复路径解析，只在回归测试锁定后下沉公共 helper。

### 2) 完成文件图标的分类与视觉映射

- 从 `resourceFileIcon.tsx` 导出纯 file-kind helper，保持渲染组件为唯一图标入口。
- 对照参考 `:47571-47753` 删除无依据的“参考 parity”声明；项目额外支持的扩展名可以保留，但必须在测试表中标为 project extension，而不是 reference fixture。
- 为每个 reference kind 建立明确的 icon component 映射。现有 Lucide 图标可复用；多个 reference kind 被折叠到同一图形时，必须通过视觉审查确认可接受，不能仅以相同 `data-file-icon` 结案。
- 缺少可复用图形时，使用项目内可审计的 repo-native SVG/component 实现；不复制参考二进制资产、不新增图标依赖。

### 3) 实现统一但不强制交互的 token 组件

- 新增 `desktop-app/src/renderer/src/components/render-units/inlineReference.tsx`，唯一输入为内部 `InlineReferenceDescriptor` 和可选 resolver/capability context。
- 组件按第 2.2 节渲染：安全 URL 用 `<a>`，内部明确动作使用 `<button>`，展示型/disabled token 使用无 clickable role 的 `<span>`。
- Tab、Enter、Space、focus-visible 和 accessible name 按实际元素语义实现；展示型 token 不设置 `tabIndex=0`，除非 Tooltip 的无障碍策略明确要求且不伪造操作性。
- icon URL 和 brand color 只接受通过验证的数据；加载失败回落到本地 icon，文本必须始终可见。
- 提供稳定的 `data-inline-reference-kind`、`data-interactive`、`data-file-icon`，用于功能断言；视觉验收仍使用 computed style/screenshot。

### 4) 接入助手 Markdown 与选择性 inline code 主路径

- 在 `App.tsx:2858-2899` 的 `AssistantText` 为 Streamdown 注入模块级稳定的 `components.a`、选择性 rehype marker 和专用 inline-reference tag component；禁止注册全量 `components.inlineCode` override。
- `<a>` override 必须接收 Streamdown 产生的真实 `href/children`，通过 classifier 后渲染 `InlineReference`；未命中语义类型的安全 `http(s)` 保持普通链接行为。
- inline-code rehype marker 只改写命中的 `@path`、Markdown-style reference 和 skill；未命中的 inline code 不进入项目自定义组件，其 DOM、样式和属性必须由 Streamdown 默认 renderer 原样产生。
- fenced code block、语言高亮 code 和流式未形成稳定 inline-code 节点的内容不得被 decoration 逻辑改写。
- 从 `App.tsx:2146-2180` 向 assistant render context 注入最小稳定能力：`workspaceCwd`、`canOpenLocalPaths`、现有 conversation/internal resolver。不要把 catalog 或全局 store 直接读取散落在 token 组件中。
- 不新增 structured inline render unit/message part。若实施中发现当前 provider 已经有真实字段，先记录协议证据，再通过独立 normalizer 接入同一 descriptor，并保留 Markdown fallback。

### 5) 落实 resolver 与路径安全边界

- 列出现有 resolver/API 对照表并只接入已存在能力：本地文件、`http(s)`、conversation 以及经代码证实存在的内部导航。
- skill/plugin/agent 只有在当前项目能从 canonical identity 解析出明确目标时启用；否则按展示型 token 交付，不新增猜测式导航。
- app、MCP resource、Sites 默认展示型，除非另有独立产品需求和现有安全 API 证据；该扩展不计入本轮参考 parity。
- 相对路径继续在 main 端按 cwd containment；绝对路径/`file://` 在 renderer capability gate 后仍走 `openLocalPath`，并增加远端会话、无 cwd、无 capability 的拒绝测试。
- `http(s)` 继续走现有 `openExternalHttpUrl` 或 workspace browser；语义 custom URI 永不直接传给系统 shell。

### 6) 保持 MCP/card 与 composer 边界清晰

- `renderUnitDetails.tsx:375-386` 的 MCP `resource_link` 可复用 classifier 和 icon helper，但保持现有卡片布局及默认展示型行为，不强制复用 inline token 的 action。
- composer context 可以复用 file icon、label 和 Tooltip helper，但不改 mention 的提交编码；composer ProseMirror nodes 不作为 assistant transport 的验收依据。
- 保留 `assistantRenderUnits.ts` 的 end-resource 派生、排序和去重策略；inline-code decoration 不产生新的 end-resource。

### 7) 分层验证真实生产路径

- 单元层：参考 classifier fixture、inline-code fixture、path/capability/security matrix、file icon classification、icon visual snapshot、token 语义和 Tooltip。
- 集成层：使用真实 Streamdown `components.a`、选择性 rehype marker 和专用 tag component，不得只 mock 最终 descriptor；对普通 inline code 与无增强的 Streamdown 做 DOM baseline 对比，并覆盖 fenced code block、完整文本与分段 streaming delta。
- provider 层：分别从 history `agentMessage.text` 和 live event mapper 输入同一 Markdown fixture，断言最终渲染一致。
- MCP/card 层：断言 resource token/card 展示、fallback 及零 handler 调用。
- E2E 层：fixture 直接写入真实 Markdown/custom URI 和 inline code，不使用 mock descriptor；覆盖首屏、流式结束、任务重新打开、hover、keyboard focus 和安全点击。
- 视觉层：在 light/dark 各做至少一张稳定截图，包含 file、conversation、skill、展示型 MCP resource、普通外链和 disabled token。

## 5. 测试文件与建议命令

建议新增或扩展：

- `desktop-app/src/renderer/src/lib/referenceInlineTarget.test.ts`
- `desktop-app/src/renderer/src/lib/referenceInlineCode.test.ts`
- `desktop-app/src/renderer/src/components/render-units/inlineReference.test.tsx`
- `desktop-app/src/renderer/src/components/render-units/resourceFileIcon.test.tsx`
- `desktop-app/src/renderer/src/lib/assistantRenderUnits.test.ts`
- `desktop-app/src/renderer/src/components/render-units/renderUnitDetails.test.tsx`
- `desktop-app/src/renderer/src/App.test.tsx`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/history-mapper.test.ts`
- `desktop-app/vendors/ai-sdk-provider-codex-asp/src/protocol/event-mapper.test.ts`
- `desktop-app/tests/e2e/render-units.e2e.ts`

验证命令：

```bash
npm --prefix desktop-app run test:unit -- src/renderer/src/lib/referenceInlineTarget.test.ts src/renderer/src/lib/referenceInlineCode.test.ts src/renderer/src/components/render-units/inlineReference.test.tsx src/renderer/src/components/render-units/resourceFileIcon.test.tsx src/renderer/src/lib/assistantRenderUnits.test.ts src/renderer/src/components/render-units/renderUnitDetails.test.tsx src/renderer/src/App.test.tsx
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run lint
npm --prefix desktop-app run test:unit
npm --prefix desktop-app run test:e2e -- tests/e2e/render-units.e2e.ts
```

若 provider 测试有独立脚本，实施时先读取该 package 的 `package.json`，使用现有脚本，不新增重复 test runner。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| custom URI 被 Markdown sanitizer 删除，导致 classifier 收不到原始 href。 | 在第 1 步显式验证 Streamdown URL transform；仅 allowlist 参考语义 scheme并在内部消费。 |
| mock descriptor 测试通过，但真实 history/live text 不工作。 | 集成和 E2E 必须输入真实 Markdown/custom URI，descriptor 仅作为组件单测输入。 |
| 注册 `components.inlineCode` 后普通 code 被全量接管，造成样式或属性回归。 | 不注册全量 override；只在 rehype 阶段标记明确命中的非代码块节点，并以 baseline DOM 等值测试锁定普通 inline code。 |
| composer schema 再次被误当成 assistant protocol。 | reference fixture 只来自 `DQ/vYe/oJe`；composer 证据仅用于作者侧兼容说明。 |
| 所有 token 被统一组件错误地变成可点击。 | 交互矩阵 + `data-interactive` + role/tabIndex/handler 零调用测试。 |
| 只验证 file kind，实际图标仍与参考差异明显。 | 每个 reference kind 增加组件映射与视觉 snapshot；显式记录允许的产品差异。 |
| 绝对路径绕过 cwd containment。 | 不声称 absolute path contained；使用会话来源/capability gate、main handler 和负例矩阵共同约束。 |
| 流式重渲染造成 Tooltip/resolver 抖动或重复点击。 | 模块级 components、稳定 context snapshot、单次 handler 断言和流式 E2E。 |
| 产品附图样式与参考 bundle 样式冲突。 | 行为 parity 与视觉覆盖分开验收；文档和测试明确 dotted 是产品覆盖。 |

## 7. 完成定义

只有同时满足以下条件，才可宣称完成“参考项目对话流内联链接复刻”：

1. 参考 `DQ()` 和 `oJe()` 的全部纳入范围 fixture 在真实 Markdown/选择性 inline-code 生产路径中通过，且普通 inline code 与 Streamdown baseline DOM 完全一致；
2. history、live streaming、任务重新打开三种入口渲染一致；
3. 第 2.2 节交互矩阵全部通过，展示型 token 不伪造导航；
4. 文件分类和视觉图标两层验收均通过，不能只依赖 `data-file-icon`；
5. 产品视觉覆盖在 light/dark、mouse/keyboard 下通过 computed style 与截图验证；
6. 危险 scheme、越界路径、远端本地路径和缺失 resolver 均证明零副作用；
7. MCP resource、composer、end-resource、普通 Markdown/code/math/Mermaid/CJK 无回归；
8. typecheck、lint、unit、目标 E2E 全部通过；
9. diff 中没有 codex app-server 修改，没有无真实字段来源的协议扩展，也没有新增依赖。

任一完成条件未满足时，只能标记为“部分内联链接增强”，不能标记为 parity 完成。
