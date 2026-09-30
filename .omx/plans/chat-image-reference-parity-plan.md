# 聊天图片展示与参考项目对齐实施计划

日期：2026-09-29。规划模式：`$plan` 直接规划。状态：开发与适用环境验收完成；三项参考决策、A1–A15 证据和环境限制均已记录。

## 目标与范围

让聊天正文中的本地图片能够显示，并复刻参考项目的 Agent 查看图片记录、加载与失败处理、统一大图预览。复用已有 assistant-ui 消息和附件管理；图片展示采用其官方 Image Element 的组合方式，在真实图片消息上下文中才使用 `MessagePartPrimitive.Image`。

本次完成以下内容：

1. 正文 Markdown 图片：本地路径转换、图片缩略展示、失败占位、同一条消息内多图预览。
2. Agent 查看图片：原生 `imageView` 的计数记录、过程区与记录的两级折叠、展开后的横向缩略图、点击预览。
3. 统一图片状态：地址解析、浏览器加载、显示成功、显示失败，以及来源变化与流式更新期间的稳定性。
4. 大图预览：暗色遮罩、适应窗口、缩放、平移、前后切换、下载、键盘与触摸操作。
5. 将已有输入框附件、已发送图片附件和生成图片的预览入口接到同一弹窗，保留各自的发送、移除和生成状态。

视频、音频、Office 预览和远程宿主文件读取能力不在本次范围。图片展示不改变原始 Markdown、模型输入或 app-server 协议，不修改 `codex/codex-rs/app-server/`，不新增依赖。

## 已确认的实现基础

以下是现状证据；后文的“新增”“调整”均为实施决定。

| 编号 | 已确认的事实 | 代码证据 |
| --- | --- | --- |
| P1 | 正文使用 Streamdown；自定义组件只有链接和行内代码，没有图片处理。URL 转换不会将本地路径变成媒体地址。 | [Markdown 组件表](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:420)、[正文渲染入口](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:3231)、[URL 转换](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/referenceInlineTarget.ts:186) |
| P2 | Main 已有通用 `toAppMediaUrl` 和 `app://fs` 协议，支持本机绝对路径、file URL 与已登记媒体类型。它不是聊天相对路径解析器。 | [路径转换](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localMediaProtocol.ts:160)、[媒体 URL 校验](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localMediaProtocol.ts:187)、[流式文件响应](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localMediaProtocol.ts:315) |
| P3 | 相对路径解析已有函数；线程对应的工作目录和宿主也有 Main 业务入口。右侧文件区已经使用这些目标信息并判断本地宿主。 | [相对路径解析](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localPathOpen.ts:36)、[线程目标解析](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/projects/ProjectService.ts:119)、[本地目标检查](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/rightWorkspace/registerRightWorkspaceIpc.ts:155) |
| P4 | 普通桌面能力通过 shared contract → preload invoke → Main handler；聊天 MessagePort 有单独接口。 | [Codex 业务 API](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/shared/codexIpcApi.ts:681)、[preload API](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/preload/index.ts:133)、[Main 注册](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/index.ts:1153)、[聊天流桥接](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/preload/chatStreamBridge.ts:43) |
| P5 | 附件已具备图片来源、缩略图、发送状态和单图 Dialog；File 的 object URL 有释放逻辑。当前 Dialog 没有统一缩放、多图切换与下载。 | [来源与生命周期](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/assistant-ui/attachment.tsx:34)、[当前预览](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/assistant-ui/attachment.tsx:77)、[当前弹窗](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/assistant-ui/attachment.tsx:95)、[发送状态](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/assistant-ui/attachment.tsx:166)、[附件列表](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/assistant-ui/attachment.tsx:310) |
| P6 | 图片附件 adapter 负责 File 与 data URL 的发送处理；本地选择器已生成 app 媒体 URL。 | [图片 adapter](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/composer/imageAttachmentAdapter.ts:239)、[本地选择器](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localContextPicker.ts:93) |
| P7 | 原生 imageView 已携带 `path`，映射为 `codex_image_view`；实时 normalizer 和历史映射已经保留它。 | [工具名与输入](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/shared-item-extractors.ts:119)、[path 输入](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/shared-item-extractors.ts:178)、[实时事件](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/run-events/CodexRunEventNormalizer.ts:653)、[历史映射](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/conversations/CodexHistoryUiMessageMapper.ts:139) |
| P8 | 当前渲染单元没有 image-view 分组；相邻工具合并会吸收除 multi-agent 外的工具组。工具项保留原始 item、输入和 ID。 | [分组类型](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:88)、[分组流水线](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:420)、[工具数据](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:1821)、[相邻合并判定](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:2066) |
| P9 | 工具摘要已有查看图片计数；App 通过通用 ToolGroupUnit 与折叠壳显示工具。 | [查看图片计数](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/toolGroupSummary.ts:106)、[工具组入口](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:3248)、[折叠壳](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/toolActivityGroupShell.tsx:1) |
| P10 | 生成图片已有独立 ImageGallery 和简易放大；该文件的图片来源 helper 只接受 data URL，不能直接放宽后承担所有来源校验。 | [生成图片入口](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx:797)、[ImageGallery](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx:1134)、[来源限制](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx:2091) |
| P11 | 当前转换器把 assistant file 映射为 runtime file；用户图片则在附件内容中。正文 Markdown 与工具记录没有天然的 Image primitive part 上下文。 | [消息转换](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:2593)、[assistant file](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:2677)、[用户图片附件](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:2695) |
| P12 | 现有真实 Electron E2E 只替换模型 HTTP 边界，已覆盖附件切换会话与重载，可扩展图片场景。 | [模型边界 fixture](/Users/nallylin/Documents/code/dasCowork/desktop-app/tests/e2e/support/mockBackend.ts:231)、[附件 E2E](/Users/nallylin/Documents/code/dasCowork/desktop-app/tests/e2e/chat.e2e.ts:315) |
| P13 | 外层过程组仍会包裹普通工具，UI 只按 active/用户展开值控制；没有最终回答的结束消息也可能默认收起。UI 的 cancelled reason 又可能由原生 interrupted 映射而来，不能直接当作参考的明确取消标志。 | [过程分段](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:1499)、[外层独立判定](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts:1558)、[当前外层折叠](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:3009)、[终止状态转换](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/App.tsx:2759) |

## assistant-ui 使用决策

当前安装版本为 `@assistant-ui/react@0.14.24`，见 [依赖声明](/Users/nallylin/Documents/code/dasCowork/desktop-app/package.json:105)。

`MessagePartPrimitive.Image` 会无条件调用 `useMessagePartImage()`；后者要求当前 part 类型为 image，因此它不能直接嵌入正文 Markdown 的 img renderer 或 imageView 工具详情。虽然它转发 img 属性，可以传入 `onLoad`、`onError` 和样式，但没有现成的多图、缩放与下载。证据：[Image 实现](/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/@assistant-ui/react/src/primitives/messagePart/MessagePartImage.tsx:39)、[上下文检查](/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/@assistant-ui/react/src/primitives/messagePart/useMessagePartImage.ts:21)，以及 [官方 primitive 文档](https://www.assistant-ui.com/docs/api-reference/primitives/message-part)。

官方 [Image Element](https://www.assistant-ui.com/elements/image) 是可复制到项目的 UI 组合，具有 Preview、加载/错误和 Zoom 等组成部分，适合本次展示层；它与已安装包中的 Image primitive 是两个层次。采用其组件职责和状态组合方式，用项目现有 Dialog 与样式实现共享图片展示及参考项目的大图交互，不升级依赖。仅在已有真实 image part 上下文的入口中包一层 primitive；不为 Markdown、工具记录构造虚假的图片 part、额外 runtime 或错用原始 partIndex。[消息作用域文档](https://www.assistant-ui.com/docs/primitives/message)、[作用域 provider 文档](https://www.assistant-ui.com/docs/api-reference/context-providers/scoped-providers)、[当前 part 映射 P11](#已确认的实现基础)。

## 参考项目行为基准

参考版本：`codex-electron-26.818.21641-beautified`。本轮完整 `reference:chatgpt:validate` 通过：7188/7188 文件，200 条位置记录。索引来源为 `beautified-fallback`，排版前原包镜像不可用，以下使用原参考可读文件行号，不声明 raw 行列。

| 编号 | 需要对齐的行为 | 连接证据 |
| --- | --- | --- |
| R1 | 正文的 img token 接到自定义媒体组件；本地图片由宿主读取二进制，再转换为展示源。 | [Markdown img 入口](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:307123)、[组件表](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:319342)、[媒体组件](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317670)、[read-file-binary 调用](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317738)、[Main 读取 handler](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:60912) |
| R2 | 解析本地地址、保留宿主上下文；区分加载分支与失败占位。普通正文初次解析时不显示内容，文件预览可显示加载占位；失败显示图片不可用。 | [本地地址解析](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:141654)、[宿主与相对路径](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317700)、[加载分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317851)、[失败分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317897) |
| R3 | 正文图片为带圆角、边框与阴影的按钮，普通缩略尺寸上限 200px；点击时在正文容器内收集图片并打开共享预览。 | [图片按钮与 img](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:318102)、[点击收集](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:318209)、[共享弹窗](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:318316)、[尺寸样式](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:318445) |
| R4 | 连续 imageView 合为查看图片记录，默认折叠；展开后横向展示 80px 缩略图，使用会话宿主读取图片并接到同一个大图弹窗。 | [连续 imageView 分组](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:173398)、[默认折叠与摘要](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:17387)、[展开后图片列表](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:17424)、[宿主读取](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:16518)、[80px 图片与弹窗](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:16784) |
| R5 | 大图使用近黑色全窗遮罩，适应窗口但初始不放大超过原尺寸；支持前后、Ctrl+滚轮、触摸平移与双指缩放、缩放控制和下载。 | [共享 Dialog](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:315763)、[缩放锚点](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:315933)、[滚轮与触摸](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:315993)、[遮罩与前后按钮](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:316461)、[fit 计算](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:316516)、[下载分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:316228) |
| R6 | 输入附件也复用同一个大图弹窗。 | [附件入口](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:654420)、[附件弹窗调用](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:507186) |
| R7 | 正文图片来源先按本地 URL 规则解码，再交给文件读取：绝对地址使用 decodeURI 并处理 `%23`/`%3F`，file URL 解码 pathname，相对地址解码后连接目录。 | [Uhn 地址解码](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:141654)、[Whn 相对地址](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:141674)、[正文来源解析与读取参数](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317700) |
| R8 | 普通聊天采用两级折叠：image-view 在活动流内 standalone，但不属于永远留在外层的 persistent 项；最终回答开始后才允许过程区折叠，图片记录自身始终默认收起。 | [活动内 standalone 分类](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/agent-activity-item-JKZ97aHB.js:1497)、[普通聊天外层入口](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/local-conversation-turn-BHjJNVY8.js:3290)、[折叠条件](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:27871)、[persistent 分类不含 image-view](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:27617)、[图片记录内层状态](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:17391) |
| R9 | image-view 是固定的出现项记录：分组只保存 id、imageCount、imagePaths，标题只按数量显示 Viewed；持久化条目只有 type/id/path，turn 状态和图片读取结果不改变标题。 | [分组数据](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:173398)、[固定计数标题](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:17409)、[imageView 序列化](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:452538)、[turn 状态单独更新](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:136015)、[本地图片读取失败返回 null](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:233813) |

上述原文件 SHA256：

- `app-initial-DOX-K1rC.js`：`3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4`
- `main-Cwjv9Ibf.js`：`f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e3e0bef4556264a515f70ef3a`
- `subagent-activity-chip-group-D79ZCRCy.js`：`0d5f5cb478a83cdda14e25c1628339aec7864d31ce4113e0d6d3c83e90fbc1ec`
- `agent-activity-item-JKZ97aHB.js`：`7c1573464fae049c742ae61d1187fc1361fa0ace851d603de4cc865af7b5f7b7`
- `local-conversation-turn-BHjJNVY8.js`：`37b8819ad5c954353724dc2688ca88aad10bb283f850f7ae9d68e48560fd2b72`

## 三个审查问题的参考方案

| 审查问题 | 参考项目如何处理 | 本项目采用的方案 |
| --- | --- | --- |
| 编码后的 Markdown 地址能否直接当磁盘路径？ | 不能。R7 的 `Uhn` 先解码绝对地址或 file URL；`Whn` 解码相对地址后连接所在目录，再交给读取组件。 | 正文按 URL 解码一次；原生 `imageView.path` 保持字面值。来源类别贯穿解析、缓存、重试与保存，避免 `%20` 文件名被误解码。详见设计决定 1 与 A2。 |
| 查看图片记录是否应一直留在最终正文旁？ | 否。R8 的 standalone 只表示活动流内部的独立项。普通聊天仍有过程区和图片记录两级折叠；最终回答开始且未明确取消时才允许外层收起，内层默认收起。 | 图片记录留在过程区；外层按 final、明确取消和用户选择控制，内层展开才读取图片。没有 final 的停止/失败消息保持外层展开。详见设计决定 3 与 A6。 |
| “已查看”能否用于推断成功、失败或历史执行状态？ | 不能。R9 的分组只有 id、数量与路径，标题固定按出现项计数；图片读取结果和 turn 状态不改变它。 | 固定显示“已查看 N 张图片”，按 item ID 去重。保留真实错误信息；加载失败单独显示图片不可用，不补造历史 success/error。详见设计决定 2、3 与 A7/A15。 |

本表采用普通聊天入口的 R7–R9 证据。相对路径以线程 cwd 为基准、来源类别和明确失败标签属于本项目适配；不把这些类型与标签描述成参考项目已有实现。

## 设计决定

### 1. 读取与来源

本地图片沿用 P2 的流式媒体协议，Main 把受支持地址解析为 `app://fs/...`，Renderer 使用该地址加载图片。参考项目 R1 主要通过二进制/base64 展示本地正文图片；本项目采用既有协议实现同样的界面行为，避免再建立一套全文件读取与 base64 缓存。

新增白名单业务 API `window.desktopApp.codex.resolveImageSource()`。输入包含来源类别、原始来源及消息所属 conversation/thread 标识；Main 解析目标宿主和工作目录，返回可展示来源或明确的不可用原因。Renderer 不提供任意 cwd，也不能自行读取磁盘。普通 invoke 即可，不放入聊天流桥接。依据 P2、P3、P4。

沿用 R7 的“先解析 URL、再读文件”顺序，并在本项目显式区分 `markdown-url`、`native-path` 与已经解析的媒体来源。本项目 Markdown 图片经过 [normalizeUri](/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/mdast-util-to-hast/lib/handlers/image.js:21) 后才进入 img renderer，空格和中文可能已变为百分号编码；不能将这个值直接当磁盘路径。Main 对 `markdown-url` 执行一次对应的 URL 解码，对原生 `imageView.path` 的 `native-path` 保持字面路径。来源类别只决定解析方式，所有类别仍经过宿主、路径和图像校验。

| 来源 | 本次处理方式 |
| --- | --- |
| 本机绝对路径 | Markdown URL 先按 R7 解码；原生磁盘 path 不解码。Main 校验图像类型、文件存在且为普通文件，再调用 `toAppMediaUrl`。 |
| `file://` | 按 file URL 解码 pathname 一次后走本地流程；拒绝不支持的 authority，不再对解码结果重复套绝对 URL 解码。 |
| `sandbox:/绝对路径` | Markdown URL 去掉 sandbox 前缀并解码一次，再按本机绝对路径处理；不猜测文件名或替换不存在的挂载点。 |
| 相对路径 | Markdown URL 先解码路径部分，再按消息所属线程的 cwd 解析，复用 P3 的本地路径规则；切换当前项目不得改变旧消息结果。聊天没有文档文件名时，以线程 cwd 为基准。 |
| `app://fs` | Main 使用已有媒体 URL 校验与路径反解，确认是图像后返回；不允许任意 app URL。 |
| `data:image/...` | 使用共享图像来源校验；不把任意 data 内容当作图像。 |
| `blob:` | 只使用当前应用为 File 创建并持有的来源；模型文字中任意 blob 地址不直接信任。 |
| HTTP(S) | 延续现有 URL 类型校验与应用策略，浏览器直接加载；错误进入统一失败状态。 |
| 远程宿主的本地文件地址 | 返回本次不支持读取该宿主图片；不得误读为本机同名文件。 |

图像描述保留稳定 ID、来源类别、原始来源、解析后的磁盘路径/可展示来源、alt/title、消息归属和下载信息。保存和重试保留相同来源类别，不把已经解码的路径再次当作 Markdown URL。原生路径中的 `#`、`?`、空格、中文和字面 `%20` 保持原样；Markdown URL 中的字面 `#`/`?` 文件名使用 `%23`/`%3F`，字面 `%20` 文件名使用 `%2520`。file/app URI 按对应协议解码一次。该来源标注是本项目为兼容不同入口增加的边界，不声称参考项目使用相同类型定义。路径细节沿用 P2、P3、R7。

参考项目的私有远程 URL 安全端点不移植到本项目，见 [参考媒体检查分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:317506)。本次也不声明拥有参考项目的远程执行宿主能力。

### 2. 展示状态与列表

新增不依赖 message part 上下文的共享图片展示组件，接入 Image Element 的状态组合思路，适配现有 UI。

状态为 `resolving → loading → ready`，任一读取或解码失败转为 `unavailable`；来源或归属变化时重新开始。普通正文在地址解析期间遵循 R2 暂不显示图片；开始浏览器加载后用受缩略尺寸约束的占位，成功才开放预览。工具条与附件已有固定布局，加载时保留位置。失败展示图标和 alt/“图片不可用”，不遗留浏览器破图或无限 spinner。

图片显示状态与工具执行状态、附件上传/发送状态、图片生成状态分别处理。image-view 按参考项目 R9 显示出现的查看记录，不以图片加载结果证明工具成功；文件稍后被删除，记录数量和标题保持，缩略图显示不可用。参考 Agent 本地图片读取失败返回 null 并保留图标占位，见 [Agent 图片为空分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:16659)；本项目对本地失败增加明确的“图片不可用”状态是适配改进，不声明参考已有相同的本地失败标签。

地址解析按 `(消息归属、来源类别、来源)` 合并并发请求；已成功结果在挂载期间复用，最后一个消费者离开后最多保留 15 秒。来源变化后忽略旧异步响应；普通文本流式更新不能重复请求。失败不由每个文本 token 自动重试；只有明确重试、来源变化或新的挂载周期重新加载。已打开弹窗由不会随图片条折叠而卸载的父层持有 descriptor；File/object URL 保留到弹窗关闭后再释放，不因触发图片条卸载而失效。

正文按 R3 使用图片按钮、200px 普通尺寸上限、圆角/边框/阴影与 `object-contain`。同一条 assistant 消息建立 root ref，点击时按 DOM 顺序收集该 root 下已就绪的图片标记；不跨消息收集。图片列表保持稳定 ID，以被点击图片定位初始 index。imageView 和附件已有明确列表，直接传入 descriptor 数组。

### 3. Agent 查看图片记录

在 P8 的渲染单元新增 `image-view` 分组，只识别原生 imageView 与已确认的 `codex_image_view` 输入。连续查看操作合并为一组；正文、其他工具或 turn 边界结束当前组。新组在通用相邻工具合并前生成，并明确排除通用合并，避免被重新吸收为 composite。

按 R8 保留两级折叠：图片记录是过程区里的独立项，仍由 `groupAssistantProcess` / `groupProcessSegments` 包裹；不要将它加入 `shouldRenderOutsideProcessGroup`，也不设置 `standaloneInConversation` 将它移到外层最终正文旁。参考的 standalone 只表示活动流内部不与其他活动合并。用户先展开过程区，再展开图片记录，才挂载缩略图。

外层折叠按最终回答是否开始决定，不能只依赖 turn 是否 running/完成。将 P13 的外层展示条件与“正在执行”的状态分开：

- 尚无最终回答：外层过程区展开且不可收起，包括没有最终回答的停止/失败消息；图片记录自己的图片条仍默认收起。
- 最终回答已经开始且没有明确 cancelled 标志：外层可以默认自动收起，即使最终回答仍在流式输出；最终正文始终留在外层。
- 明确 cancelled 阻止外层自动折叠；interrupted/stopped 自身不构成这个标志，仍按有没有最终回答决定。
- `forceExpanded` / `disableCollapse` 保持外层展开；`preventAutoCollapse` 或用户已选择展开时不覆盖用户选择。外层与内层选择各自在当前组件挂载期间保持，不以图片加载成功或失败改变它们。收起并重新展开过程区后，图片记录回到默认收起。

上述重置同样遵循参考：普通聊天的外层在 [收起分支](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:28112) 不再创建过程内容，退出动画后卸载；image-view 不在 persistent 白名单，内层 [QT 的本地 state](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/subagent-activity-chip-group-D79ZCRCy.js:17391) 初始为 false。已打开的大图仍由持续挂载的共享预览父层持有。

参考普通聊天的明确取消来自 [turn.status === cancelled](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/local-conversation-turn-BHjJNVY8.js:2533)，[传给过程区的条件](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/local-conversation-turn-BHjJNVY8.js:3305) 是 `!activitySummaryWithoutAssistant && cancelled`；上述规则针对本次普通聊天过程区，不将其他 summary 分支的标志混入。

本项目适配时保留原始终止信息，也保留 P13 将 interrupted 映射为 assistant-ui cancelled reason 的现有消息兼容行为。外层折叠读取原始 codexTurn 状态与最终回答阶段，不能直接用该 reason 代替参考的明确取消标志；只有已有、可追溯的用户主动取消信号才能提供 `explicitUserCancelled`。缺少该信号时按 interrupted 规则处理，不新增伪造的 app-server cancelled 状态。实现仅调整过程区 UI 所需的折叠上下文，不改写原生 turn/item 语义。

开发验收确认，当前 app-server 的 `legacy` 历史模式在完成后未从原生历史接口返回 imageView，即使 rollout 含有原始调用。本项目新建需要保存的线程因此使用协议已有的 `historyMode: 'paginated'`，历史读取继续通过 `listTurns(itemsView: 'full')`；临时线程不设置该选项，恢复线程沿用已有模式。真实 Electron 验证分页历史返回原始 imageView ID/path 后再交给 P7 映射，未新增桌面历史协议或旁路日志重建。协议定义见 [ThreadStartParams](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadStartParams.ts:44)、[ThreadHistoryMode](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadHistoryMode.ts:5)。旧 legacy 线程仅展示原生接口实际返回的记录；已经缺失的记录不能由本次 UI 改动恢复。

保留每个调用的 item ID、partIndices、path 和实际已有的事件信息，按不同 item ID 计数。同一路径被两个不同调用查看，数量为 2；同一 item 的流式更新或 journal 重放不重复计数。保留现有工具定位/展开关联。依据 P7、P8、P9。

界面沿用折叠壳：默认收起，固定摘要为“已查看 1 张图片/已查看 N 张图片”，对应参考的 Viewed an image / Viewed N images。这个标签表示出现的 imageView 记录数量，不声明单次工具执行成功。记录一出现即可形成摘要，不增加参考没有的“正在查看/查看失败/已停止”标题；父层仍可显示 turn 运行、失败或停止状态。展开才解析图片来源，横向显示 80px `object-cover` 缩略图；缺失图片不减少数量，单张失败不影响其他图片。点击打开共享预览。对齐 R4、R9。

实时的 item/started 与 item/completed 使用同一 item ID 更新记录；参考在 [started 入 turn](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:136224) 与 [completed 同 ID 更新](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:136321) 都保留 item。历史按持久化 id/path 重建相同计数记录，不要求协议不存在的 success/error 字段。本项目原生 [imageView 类型](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadItem.ts:117) 只有 id/path，[历史映射的 output-available](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/conversations/CodexHistoryUiMessageMapper.ts:342) 不能当成成功证据；[实时已有的 error result](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/run-events/CodexRunEventNormalizer.ts:1271) 保留在原始事件/既有错误展示中，但不伪造到历史。不得根据失败 turn 将此前全部图片记录标为失败，也不得根据可加载缩略图补造成功。

### 4. 大图预览与保存

使用现有 Dialog 实现全窗预览，暗色遮罩接近 `black/90`，带关闭按钮、可访问名称和焦点管理。底部显示缩小、百分比、放大；多图时显示前后按钮并支持左右方向键。Esc 关闭并返回触发按钮；快捷键只在当前弹窗内生效，不截获输入控件的方向键。对齐 R5，复用 P5 的 Dialog 基础。

初始比例为 `min(1, viewportWidth/naturalWidth, viewportHeight/naturalHeight) × 100%`，使用扣除弹窗控制区后的可用区域。参考档位为 25、33、50、67、75、80、90、100、110、125、150、175、200、250、300、400、500%；插入当前 fit 比例，最小值为 `min(25, fit)`，最大 500%。依据 [参考缩放档位](/Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:25256) 与 R5。

Ctrl+滚轮按连续比例缩放，以指针所指图片位置为锚点修正滚动位置；普通滚轮保持滚动。触摸支持单指平移、双指缩放。切换图片重置自然尺寸、比例与滚动；fit 模式在窗口变化时重新适配，用户主动缩放后的比例保留并约束滚动范围。图片加载失败保留关闭和前后操作。

下载采用新增 `window.desktopApp.codex.saveImage()` 业务能力：

- 本地路径/app 媒体来源：Main 重新校验原始来源，弹出保存对话框，复制原始图片字节；避免通过 canvas 转码。
- data URL：Main 校验图像 MIME 与编码后保存原始字节；File/blob 仅在点击下载时由持有该 File 的 Renderer 转换为图像数据，不在缩略展示阶段转换。
- HTTP(S)：由当前桌面窗口的 `webContents.downloadURL` 发起，处理该窗口/该请求的 `will-download` 与 `done`，返回完成、取消或失败。并发同来源请求串行关联，监听器完成后移除，不改变右侧浏览器分区的下载策略。

HTTP 下载不通过打开外部链接冒充成功。Electron 支持不导航地发起下载和自定义原生保存对话框，见 [downloadURL 文档](https://www.electronjs.org/docs/latest/api/web-contents#contentsdownloadurlurl-options)、[DownloadItem 文档](https://www.electronjs.org/docs/latest/api/download-item)、[本地 Electron 类型](/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules/electron/electron.d.ts:17219)。现有右侧嵌入浏览器禁下载在 [独立 session handler](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/rightWorkspace/registerRightWorkspaceIpc.ts:636)，不复用为聊天保存服务。

### 5. 其他图片入口

附件继续使用 assistant-ui `AttachmentPrimitive` 与 P6 adapter；替换 P5 的单图 Dialog，允许在当前输入附件或当前用户消息附件内切换图片。保留移除按钮、发送状态、File object URL 释放、文件名与 MIME。依据 R6。

已有生成图片列表继续使用原始生成记录；用共享展示与弹窗替换 P10 的简易放大。新来源先经过统一校验，不能直接放宽旧 data-only helper。只统一预览入口，不重写生成工具协议。

## 可验收标准

| 编号 | 可验证的结果 | 主要验证方式 |
| --- | --- | --- |
| A1 | 有效本地 PNG/JPEG 的绝对路径、file URL、sandbox 地址和线程 cwd 下相对地址均能在正文显示；真实 img 的 `naturalWidth > 0`，本地图片 src 为 app 媒体地址。 | Main 单元 + Electron E2E |
| A2 | 完整 Markdown → img renderer → Main 流程中，空格、中文、`%23`/`%3F` 和 `%2520` 分别读到正确文件；原生 imageView 的字面 `%20` 路径不解码。file URL 不重复解码；Windows 驱动器路径及 file URL 在显式 Windows 平台测试中正确处理；拒绝无效 URI、目录与不支持的来源。 | 来源参数表 + Markdown 集成 + 真实磁盘 E2E；Windows 实机行为另标运行环境 |
| A3 | 旧消息相对路径使用旧线程目标；切换项目、重载与历史恢复后不读新项目的同名图片；远程宿主路径明确不可用。 | 服务测试 + 两项目 E2E |
| A4 | 可控延迟下验证 resolving/loading/ready；文件缺失、403/404、坏图像均进入 unavailable。来源变更后旧响应不覆盖新图，离开组件后不更新状态。 | hook/组件测试 + E2E |
| A5 | 同一来源初次展示最多一次解析请求；50 次正文文本增量不会增加调用数。同归属并发消费者共享请求；不同线程同名相对地址不共享。 | hook 调用计数测试 |
| A6 | 完整 `commentary → imageView×2 → final_answer` 消息：final 开始前过程区展开、图片记录默认收起；final 开始后即使仍 running，外层可自动收起。展开外层再展开图片记录出现两张 80px 图片并能预览；任一级收起时不挂载新图片条。无 final 的停止/失败消息外层展开；带 final 的 interrupted 按同一折叠规则；明确 cancelled、强制展开和用户选择按 R8 生效。最终正文不被过程区隐藏。 | 完整消息/两级折叠组件测试 + 流式/停止/历史 Electron E2E |
| A7 | 同路径不同 item ID 计数为 2，同 item started/completed 更新和重放不重复；中间有正文或其他工具时分组断开。运行、停止、失败 turn 与缺失图片不改固定计数标题；无 imageView 条目的失败不补造记录。不从图片加载或 turn 状态生成单次 success/error，真实错误信息仍保留；partIndices 和定位正确。 | render unit/摘要测试 + 实时事件/历史恢复测试 |
| A8 | 正文 A 消息中 3 张图按出现顺序切换，从中间图片打开 index 正确；B 消息图片不混入。单张场景隐藏前后控制，多图边界不越界。 | 组件测试 + E2E |
| A9 | 大图初始 fit 不超过 100%；加减遵循档位和 fit 插入，范围满足 `min(25,fit)` 至 500%；切图重置，窗口调整遵循 fit/主动缩放区别。 | 缩放纯函数与组件测试 |
| A10 | Ctrl+滚轮缩放后锚点位置误差不超过 2 CSS px；普通滚轮不触发缩放；拖动和平移可到达放大图边缘，双指输入正确改变比例。 | 几何测试 + Electron 交互；触摸实机证据另记 |
| A11 | Esc、关闭按钮、左右方向键与 Tab 焦点范围正确；关闭后焦点回到触发按钮，正文/输入框快捷键不被弹窗全局截获。 | Dialog 组件 + E2E |
| A12 | 本地、data/File 和 HTTP 图片均保存出实际文件，其字节摘要与原始 fixture 相同；取消不报失败，下载中断显示失败并允许重试。图片保存不改变聊天页面位置。 | Main 保存测试 + 真实 Electron 下载测试 |
| A13 | 输入附件仍能选择/粘贴/拖入、移除、发送；发送数据与 MIME 正确；当前附件和已发送附件使用统一预览且 object URL 生命周期正确。 | 既有 adapter/picker 测试 + 附件 E2E |
| A14 | 生成图片入口使用相同预览，已有列表数量与生成状态保留；非图像 data、任意 blob/app URL 未因复用而被直接开放。 | 来源/生成图片组件测试 |
| A15 | 实时、停止/失败消息和历史恢复按同样的 id/path 展示图片记录；历史只有 id/path 时仍能重建固定标题，但不补造调用成功/失败。只有真实持久化条目才能在重载后出现；无 app-server 修改、raw RPC/Node 进入 Renderer或协议输入输出变形。 | 恢复/E2E + 现有边界检查 |

## 实施步骤与文件归属

步骤按依赖推进。新增路径是拟定文件，执行时可合并到已有同职责文件，避免为了组件数量拆分。

### 第 1 步：锁定现状与最小复现

- 在现有 P1/P8/P12 测试入口建立 fixtures：正文有效/缺失图片、连续 imageView、同路径不同调用、历史恢复及附件。
- 先验证当前附件发送与工具分组行为，补足本次将改变的边界测试；测试应检查用户行为、调用 ID 和真实图片解码，不复制实现细节。
- 为复刻 UI 准备正文、折叠/展开记录、大图和失败占位截图验收清单，依据 R1–R6。

输出：可复现当前正文图片失败的 fixture，以及保留行为的基线测试。

### 第 2 步：图片来源与保存业务 API

- 新增 `/Users/nallylin/Documents/code/dasCowork/desktop-app/src/shared/chatImageApi.ts`：带来源类别的请求、结果、保存请求与返回值的 Zod contract 和 channel；锁定 Markdown URL 解码一次与原生 path 不解码的区别，保存和重试保留类别。
- 新增 `/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/chatImages/ChatImageService.ts` 与同目录 `registerChatImageIpc.ts`：线程目标、路径解析、图像校验、本地来源与保存；复用 P2/P3，不复制协议 handler。
- 扩展 P4 的 `DesktopCodexApi`、preload 与 Main 注册。仅对可信桌面 renderer 暴露业务调用，参数在 Main 再验证；不接受 Renderer 指定任意下载写入位置。
- 为 HTTP 保存关联当前 webContents 的下载事件；完成/取消/异常/窗口销毁都清理 pending 请求与监听器。先用真实 Electron 验证下载和保存对话框语义。

输出：A1–A3 的来源能力与 A12 的保存能力；Renderer 不直接读写文件。

### 第 3 步：共享图片状态与大图组件

- 新增 `/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/images/chatImageSource.ts`：来源分类、IPC 接入、有限生命周期请求复用、稳定 descriptor；不重复建立永久全局图片 store。
- 新增同目录 `ChatImage.tsx`：加载/成功/失败组合，支持正文/工具/附件尺寸和可选 Image primitive adapter。
- 新增同目录 `ImagePreviewDialog.tsx`：共享多图 Dialog 与下载交互；将缩放计算提取到同目录 `imagePreviewGeometry.ts`，方便 A9/A10 检查。
- 复用 [现有 Dialog](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/ui/dialog.tsx:1)，按本文 assistant-ui 决策实现，无新依赖或虚构 message part。

输出：A4/A5/A8–A12 的共用能力；本步骤不改变消息发送与工具事件。

### 第 4 步：正文 Markdown 图片

- 新增 images 目录下 `MarkdownChatImage.tsx`；在 P1 的 Streamdown components 注册 img，保留已有链接、行内代码与 URL transform 行为。
- AssistantText/AssistantMessage 传入稳定的消息归属上下文，root ref 收集同消息已就绪图片；不根据活动项目重新解释旧消息，不改写原文。
- 实现 R2/R3/R7 的尺寸、解析期间、失败占位、来源解码和点击预览；从 img renderer 传入 `markdown-url`，不把编码后的 src 误标为原生 path。URL transform 若拦截本次合法图片来源，局部补充来源处理并以链接回归测试锁定原行为。

输出：正文、流式更新与重载满足 A1–A5/A8/A15。

### 第 5 步：Agent 查看图片专用记录

- 在 P8 新增 image-view 类型与连续分组，排除 generic adjacency；保留 `groupAssistantProcess` 的过程区归属，不加入 `shouldRenderOutsideProcessGroup`，调整 P9 的摘要和 ToolGroupUnit 路由。
- 在 P13 的渲染模型/ReasoningGroupUnit 分开执行状态与折叠状态，传入最终回答是否开始、可证明的取消来源、强制展开与用户选择；按 R8 实现外层规则。沿用原始 interrupted 元信息，不把 assistant-ui 转换后的 cancelled reason 当作真实取消原因。
- 新增 `/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/imageViewActivity.tsx`：固定计数标题、独立的内层展开状态与横向图片条，调用第 3 步组件。
- 使用已有 P7 事件中的原始 path/item ID，以 `native-path` 接入来源服务。实时和历史走同一计数投影，按 R9 使用固定标题，不新增历史成功/失败字段，不根据 turn 或加载状态改写调用状态；既有真实错误信息保留。不解析任意工具输出文本来猜图片路径，不新增宿主工具。

输出：A6/A7/A15，通过真实 view_image 与历史恢复验证。

### 第 6 步：附件和已有生成图片统一预览

- 在 P5 用共享弹窗替换 AttachmentPreviewDialog 的内部实现，保留 AttachmentPrimitive、列表布局、删除、上传状态与 URL 生命周期。
- 在 P10 替换 ImageGallery 的简易放大入口，保留原始生成图描述与列表；新支持来源经过第 2/3 步校验。
- 删除本次被替换的重复预览代码，不改 P6 adapter 的发送语义。

输出：A13/A14 与 R6 对齐，所有图片入口使用同一大图交互。

### 第 7 步：完整验收与证据归档

- 运行下文定向测试、桌面基线和协议边界检查；缺陷修复后只重复受影响检查，再完成未执行项。
- 新增 `/Users/nallylin/Documents/code/dasCowork/desktop-app/tests/e2e/chat-images.e2e.ts`，沿用 P12 的真实 Electron/app-server 与 mock 模型边界；模型 fixture 发起真实 `view_image` 调用，断言原生 imageView 到 UI 的完整过程。
- 保存 A1–A15 结果、界面截图、下载文件摘要，以及触摸/Windows 实机未覆盖项。代码验收与环境缺口明确分开，不能用 JSDOM 的 onLoad 模拟代替实际图片解码。

输出：每项验收均有测试或交互证据，剩余环境限制有明确记录。

## 风险与处理

| 风险 | 对应处理 |
| --- | --- |
| 把 Image primitive 当成通用 img 后出现 part 上下文错误。 | 第 3 步先做共享无上下文展示层；只有真实 image part 入口使用 primitive。依据 P11 与已核实源码。 |
| 旧线程图片被活动项目、远程同名文件或缓存混用。 | 第 2 步 Main 解析线程目标；缓存含消息归属；远程本地路径明确不可用。A3/A5 验证。 |
| Markdown 已编码路径被直接读取，或原生 `%20` 文件名被误解码。 | 来源类别进入 shared schema、缓存键和保存请求；Markdown URL 解码一次，原生 path 保持原样；A2 验证完整处理链。 |
| image-view 新组又被通用工具合并吸收，或重放重复计数。 | 同时改 P8 的生成与合并排除，按调用 ID 验证 A7，并保留 partIndices。 |
| 将 standalone 误认为必须在外层，或停止后因 active=false 隐藏无 final 的过程区。 | 保留 R8 的两级折叠，外层按 final 是否开始与真实取消来源决定；不将 image-view 加入外层独立白名单；A6 验证完整消息。 |
| 固定 Viewed 标题被当成工具成功证明，或将实时错误伪造到历史。 | 按 R9 将其定义为出现项数量记录；turn、调用事件与图片加载信息分别保留，不补造协议字段；A7/A15 验证。 |
| 流式文本引起重复读取、旧响应回写或 Dialog 在来源卸载后失效。 | 有限请求复用、来源版本检查、Dialog 持有 descriptor；A4/A5 验证。 |
| 缩放只改变 CSS，锚点与滚动失准，窗口变化产生跳动。 | 自然尺寸+可用区域计算，几何单元与真实 Electron 交互；A9/A10 验证。 |
| HTTP 下载误关联、取消悬挂或现有浏览器策略干扰。 | 当前窗口请求关联、同来源串行、done/销毁清理；不碰右侧分区；A12 验证字节与结果。 |
| 统一预览破坏附件发送、MIME 或提前 revoke blob。 | 保留 P5/P6 的来源所有权与 adapter；Dialog 期间维持来源生命周期，A13 回归。 |
| 将 data-only helper 放宽造成未验证来源进入 img。 | 新 descriptor 由统一来源校验生成，旧调用按消费者替换；A14 参数表覆盖。 |
| 只通过模拟组件事件宣称图片可显示。 | Electron 使用真实磁盘和 HTTP 图像，以 naturalWidth、截图与保存摘要验证 A1/A12/A15。 |

## 验证命令与交付证据

定向单元/集成测试覆盖新增 service、schema/preload、来源状态、几何/Dialog 与图片记录，并运行以下既有回归文件：

- [localMediaProtocol.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localMediaProtocol.test.ts)、[localPathOpen.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localPathOpen.test.ts)、[localMediaUrls.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/conversations/localMediaUrls.test.ts)、[localContextPicker.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/localContextPicker.test.ts)。
- [imageAttachmentAdapter.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/composer/imageAttachmentAdapter.test.ts)、[assistantRenderUnits.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.test.ts)、[toolGroupSummary.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/toolGroupSummary.test.ts)、[toolActivityDisplay.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/toolActivityDisplay.test.ts)。
- [CodexUiMessageAdapter.test.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/CodexUiMessageAdapter.test.ts) 和历史映射相关既有测试，用于确认原生图片记录未改变。

定向测试通过后执行：

```sh
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app test
npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run test:e2e -- tests/e2e/chat-images.e2e.ts tests/e2e/chat.e2e.ts --reporter=line
```

若实际改动 AI-free client，再运行 `npm --prefix desktop-app/vendors/codex-app-server-client run qa`；本计划预期无需修改它。E2E 启动沿用仓库现有准备流程，不用 fake app-server 代替 A6 的原生工具链证据。

最终证据至少包含：正文有效图片/失败占位截图、查看图片收起/展开截图、共享大图缩放/切换截图、保存文件 SHA256、关键测试命令结果、实时与重载结果。触摸与 Windows 实机未运行时明确注明，已有模拟输入/平台参数测试不能声明为实机验证。

## 完成条件

A1–A15 均按适用环境验证；所有受影响入口共用图片状态与预览；现有附件、链接和工具分组回归通过；Renderer/Main 边界检查通过。提交范围仅包含本计划对应能力和必要测试，没有 app-server 修改、依赖升级或与本次无关的媒体改造。

## 2026-09-29 审查后修订

1. 按参考 R7 补上正文 URL 到磁盘路径的解码阶段；本项目显式区分 Markdown URL 与原生 path，并增加完整链路、字面百分号文件名验收。
2. 按参考 R8 明确两级折叠，修正“独立记录等于永远在外层”的假设；保留过程区归属，补 final 流式开始、停止、取消与用户折叠选择验收。
3. 按参考 R9 将图片查看标题定义为固定出现项计数，移除工具成功/失败推断及无法证明的历史状态承诺；图片加载失败单独显示。
4. 补充预览父层挂载所有权及 File/object URL 生命周期，避免图片条折叠后弹窗失效；按参考明确内层展开选择不跨外层卸载保存。

## 2026-09-29 开发验收修订

1. 正文入口实际放在 [render-units/markdownChatImage.tsx](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/markdownChatImage.tsx)，共享状态和弹窗保留在 images 目录。Streamdown 的 sanitize/harden 会处理本地 img 来源，已增加限定于合法图片节点的来源保留与恢复，并回归既有链接行为。
2. 补齐 Windows 原始反斜杠地址经过 Markdown 后形成 `C:%5C...` 的处理；只在 Markdown 来源中解码一次，原生文件名中的字面 `%5C` 保持。Windows 实机仍列为环境缺口。
3. preload 新 API 的请求与返回 Zod 校验显式使用 `jitless: true`，修复严格 CSP 下的动态代码生成失败；本地媒体和 HTTP 图片通过既有图片加载入口显示。
4. 新建持久线程启用原生分页历史契约；旧 legacy 历史限制明确保留。历史本地附件按真实 path 恢复文件名与图片 MIME，无法追溯原始名字的 data/远程输入维持原生信息。
5. HTTP 保存除完成事件外也处理真实 `updated='interrupted'`：返回失败并清理/取消原生下载，用户正常取消仍为中性结果，重试可保存完整原始字节。

最终命令、A1–A15、截图和保存摘要归档在 [验收记录](/Users/nallylin/Documents/code/dasCowork/.omx/plans/chat-image-reference-parity-verification.md)。
