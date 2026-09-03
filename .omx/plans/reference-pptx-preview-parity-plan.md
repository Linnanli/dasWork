# 完整复刻参考项目 Artifact Tab PPTX 实现计划

## 计划状态

- 模式：`$plan` direct。目标已明确为“完整复刻参考项目的 Artifact Tab PPTX 实现”，本计划只定义实现与验收，不在本轮修改产品代码。
- 最终目标：在本项目中建立独立的 `artifact` 工作区标签，并完整复刻参考项目 PPTX 分支可观察到的入口、状态、读取、渲染、导航、批注审阅、会话回传、持久化和生命周期行为。
- 复刻口径：对齐参考项目的用户行为、状态流和安全边界；不复制 Walnut、Popcorn、私有 .NET/WASM、混淆代码或哈希构建产物。
- 架构边界：只修改 `desktop-app/`；禁止修改 `codex/codex-rs/app-server/`，不绕过 Codex app server，也不改 provider fork、模型调用或审批协议。
- 参考证据状态：已运行完整 `reference:chatgpt:validate`，7188/7188 文件通过，`sourceMode=beautified-fallback`。归档没有 `_analysis/raw/` 原包镜像，因此本计划提供可读文件精确行号和 SHA256，不声称拥有排版前 raw 行列证据。
- 完成判定：本计划不是“Files 工作区能显示 PPTX”就完成；只有“独立 Artifact Tab PPTX 分支”的全部纳入项均通过验收，才达到目标。

## 一、目标实现的产品闭环

完成后的链路应为：

```text
PPTX 入口
  ├─ 对话生成文件卡片 / 文件链接
  ├─ Files 工作区中的 .pptx
  └─ composer / 已发送消息中的本地 PPTX 附件
       ↓
构造 ArtifactOpenTarget
  ├─ 稳定 tabId
  ├─ preview / pinned 语义
  ├─ openSource / originatingTurn
  ├─ attachmentPreviewOrigin / requestId
  └─ navigationTarget（slide / object）
       ↓
独立 artifact 工作区标签
  ├─ 可恢复的标签状态
  ├─ 右侧 / 底部工作区移动
  └─ 同一文件重复打开时更新导航而非重复建 tab
       ↓
安全源授权 + 元数据 + 40 MiB 硬限制读取
       ↓
checksum 缓存 + Worker 异步解析
       ↓
宿主控制的 PresentationPanel
  ├─ slide rail / 当前页 / 总页数
  ├─ 初始页及对象定位
  ├─ zoom / fit / 响应式布局
  ├─ 用户点击超链接
  └─ 只读、隐藏 speaker notes
       ↓
Artifact 审阅工具
  ├─ slide / element / region 批注目标
  ├─ 保存到 composer
  ├─ 直接提交到当前会话
  ├─ 更新 / dismiss
  └─ 关闭 tab 时清理未提交批注
```

这条闭环中的任何一段缺失，都只能算局部 PPTX 预览，不能称为完整 Artifact Tab PPTX 复刻。

## 二、参考项目行为证据

### 2.1 PPTX 分类与 Artifact Tab 打开

1. 参考项目将 `.pptx` 分类为 `{ artifactType: 'slides', importKind: 'pptx' }`，传统 `.ppt` 不在该分支：
   - `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:174499-174531`
2. Artifact 内容按需加载，并使用 durable route `{ kind: 'artifact', params: { hostId, path } }`：
   - 同一文件 `:271024-271044`
3. opener 接收激活、导航目标、附件来源、host、preview/pinned、open source、originating turn、目标面板、tab ID 和标题等上下文：
   - 同一文件 `:271046-271064`
4. 稳定 tab ID 为 `artifact:${hostId}:${path}`；tab props 保存 artifact/import kind、附件预览信息、originating turn、路径、标题等；打开时设置 context menu、durable route、icon 和 preview 状态：
   - 同一文件 `:271065-271119`
5. 关闭 Artifact Tab 时会处理仍未完成的批注；同一 tab 可接收后续导航目标：
   - 同一文件 `:271120-271160`

### 2.2 ArtifactTabContent 的输入、读取和缓存

1. `ArtifactTabContent` 接收附件来源/request ID、artifact 类型、host、import kind、附件预览标志、open source、originating turn、路径、tabState、setTabState、tabId 和标题：
   - `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/artifact-tab-content.electron-DqIbnqh3.js:4720-4738`
2. 组件先读 metadata，并在普通 document/slides/spreadsheet Artifact 头部暴露“把 artifact 加入会话上下文”的动作：
   - 同一文件 `:4901-4936`
3. 预览大小门禁为 `41943040` 字节，随后调用 `read-file-binary`，并把同一 `maxBytes` 传入 main：
   - 同一文件 `:4950-4961, 4993-4999`
4. main 实际读取 `maxBytes + 1`，超限时返回空，避免仅依赖易发生竞态的 stat 后全量读取：
   - `reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:60912-60933`
5. renderer 将 base64 解码为 bytes，计算 checksum，按 cache key + bytes 复用解析结果；解析支持取消和旧结果保护：
   - `artifact-tab-content.electron-DqIbnqh3.js:6072-6207`
6. 文件源变化会刷新预览并清除/更新与旧来源绑定的 originating-turn 上下文：
   - 同一文件 `:5009-5067`

### 2.3 PresentationPanel 导航、布局和链接

1. PPTX 分支从 navigation target 和 request ID 推导初始选中页，并向 presentation panel 传入 header、隐藏 speaker notes、初始 presentation proto/slide、annotations、hyperlink、zoom 和 review tools：
   - `artifact-tab-content.electron-DqIbnqh3.js:7209-7268`
2. PresentationPanel 的公开行为包括 initial selected slide、zoom、navigation command、review tools、hyperlink、annotations 和 Worker；替换 presentation 时由 controller 管理：
   - `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/PopcornElectronPresentationPanel-DeJuBEno.js:6331-6387`
3. navigation target 可按 slide ID、slide number 或 object ID 定位，并通过 request 去重，避免同一导航命令重复执行：
   - 同一文件 `:6388-6411`
4. panel 提供 slide rail、选中页、zoom、响应式 thumbnail placement、链接和批注层：
   - 同一文件 `:6434-6469`
5. 布局在宽度 `>= 749px` 时使用固定 220px slide rail，`<= 748px` 时转为浮动 rail，`<= 688px` 时改为堆叠页布局：
   - `reference-projects/codex-electron-26.818.21641-beautified/webview/assets/PopcornElectronPresentationPanel-D3e2PrXe.css:1-225`

### 2.4 Artifact 批注与会话回传

1. 审阅事件区分 annotation target kind、submit mode 和 submit source：
   - `artifact-tab-content.electron-DqIbnqh3.js:6903-6910`
2. “保存”模式创建待提交的批注/上下文，“直接提交”模式派发 `artifact-direct-comment`；更新和 dismiss 会同步本地状态：
   - 同一文件 `:6917-7091`
3. reviewTools 向 panel 提供 submit、direct submit、update 和 dismiss 回调：
   - 同一文件 `:7126-7144`
4. 批注仅在受支持的会话上下文启用；附件预览等场景不会无条件获得审阅能力：
   - 同一文件 `:7230-7232`
5. 参考 ArtifactTab 的 PPTX 分支传入 annotations/reviewTools，但没有启用 drawing annotations 或 comment threads。因此本计划要求参考分支实际存在的点选/区域批注闭环，不把绘图、评论侧栏或 CRDT 编辑错误扩张为 PPTX 复刻内容。

### 2.5 参考文件完整性

| 文件                                                           | SHA256                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `webview/assets/app-initial-DOX-K1rC.js`                       | `3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4` |
| `webview/assets/artifact-tab-content.electron-DqIbnqh3.js`     | `5095cbf7cd0e402adfb7c1a87b5ee47b55df7839f236736f9b2ee980a19c7ed8` |
| `.vite/build/main-Cwjv9Ibf.js`                                 | `f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e3e0bef4556264a515f70ef3a` |
| `webview/assets/PopcornElectronPresentationPanel-DeJuBEno.js`  | `81c19030a7b8518adc239fd3c541cf5222df010f1c1f30a0cb5b4cd6b2ca575d` |
| `webview/assets/PopcornElectronPresentationPanel-D3e2PrXe.css` | `beeda8618769cef2f932fd4e1587dc8d67cfe1f23a535b0b25338f70174b0d02` |

跨文件索引、切片和 LSP 只用于定位；最终行为结论已经回查上述可读原文件。由于该版本是 `beautified-fallback`，实施期间若重新解包出 raw 镜像，应补充 raw 行列和 SHA，而不是覆盖现有证据。

## 三、当前项目能力与关键缺口

| 领域          | 当前能力                                                                      | 完整复刻缺口                                                                                                            |
| ------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 工作区容器    | 已有通用 `WorkspaceTabRecord`、preview/pinned、right/bottom、持久化、生命周期 | 没有 `artifact` kind、Artifact opener、durable route 语义和 artifact context menu                                       |
| Files         | 有安全 root、相对路径文件树、文本/图片/PDF 预览                               | PPTX 仍被当成普通 Files 预览；不能替代独立 Artifact Tab                                                                 |
| 本地文件安全  | workspace 文件受 owned root 约束；composer picker 有一次性 capability         | Artifact 附件预览需要可恢复、不可伪造的 source ID，不能让 renderer 传绝对路径，也不能复用会被发送流程消费的一次性 token |
| 文件读取      | 有 metadata 和 base64 binary response                                         | 通用读取上限仅 2 MiB；需要 Artifact 专用 40 MiB 硬读取，并消除 stat 后全量读的竞态                                      |
| PPTX renderer | 尚无 presentation model/panel                                                 | 必须验证公开 renderer 是否能提供稳定 slide/object/geometry；仅“画出页面”不足以支持导航和批注                            |
| 对话回传      | composer/follow-up/steer 能力存在于 `AssistantRuntimeProvider` 内             | Artifact panel 是其兄弟节点，不能直接调用 `useAui`；需要显式 conversation bridge                                        |
| 资源卡片      | 对话生成文件卡片可打开 Files workspace                                        | `.pptx` 应改为打开 Artifact Tab，并携带 originating turn/open source                                                    |
| 持久化        | generic workspace tab 可序列化恢复                                            | Artifact source 授权、navigation request、附件 correlation、缺失源错误和清理尚未定义                                    |

关键现有落点：

- `desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts`
- `desktop-app/src/renderer/src/components/workspace-container/WorkspaceContentRegistry.tsx`
- `desktop-app/src/renderer/src/components/workspace-container/workspaceReducer.ts`
- `desktop-app/src/renderer/src/components/workspace-container/workspacePersistence.ts`
- `desktop-app/src/renderer/src/components/workspace-container/WorkspacePanelController.ts`
- `desktop-app/src/renderer/src/components/right-workspace/RightWorkspaceProvider.tsx`
- `desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx`
- `desktop-app/src/renderer/src/App.tsx`
- `desktop-app/src/main/rightWorkspace/FileWorkspaceService.ts`
- `desktop-app/src/main/localPathCapabilityStore.ts`

## 四、范围边界

### 4.1 必须包含

1. 独立 `artifact` workspace tab 和 `ArtifactTabContent`，不是把 PPTX viewer 塞进 Files 预览主体。
2. `.pptx` classifier、稳定 tab ID、preview/pinned、重复打开更新、right/bottom 移动和跨重启恢复。
3. 入口覆盖：生成文件资源卡、Files 中的 PPTX、对话内文件链接、composer 本地附件、已发送附件。
4. workspace 文件与用户授权本地附件两类安全 source；renderer 不接收可随意读取的绝对路径能力。
5. metadata、40 MiB gate、实际 `maxBytes + 1` 硬读取、base64/bytes、checksum、解析缓存、源变化刷新和旧结果取消。
6. 本地离线 Worker 解析；slide rail、当前页、总页数、初始页、对象定位、zoom/fit、响应式布局、超链接和错误回退。
7. slide / element / region 审阅目标、编号 marker、批注编辑器、保存到 composer、直接提交、更新和 dismiss。
8. 普通 Artifact 头部“添加到会话上下文”动作；附件预览不重复展示该动作。
9. 关闭 tab、切换源、卸载和恢复失败时的 Worker、observer、缓存引用、pending annotations 和 source lease 清理。
10. 单元、集成、Electron E2E、packaged/offline、产物、性能和恶意文档测试。

### 4.2 明确不包含

以下能力不是参考项目当前 Artifact Tab PPTX 配置启用的行为，因此不属于“完整复刻 PPTX 分支”的缺口：

- PPTX 内容编辑、母版修改、保存回文件、协同编辑或 CRDT。
- drawing annotations、评论 threads/sidebar。
- speaker notes；参考分支明确隐藏 notes。
- 播放动画、宏、嵌入视频的完整执行语义。
- `.ppt`、`.pptm`、`.ppsx` 或其他 Artifact 类型。
- 复制参考项目私有 Walnut/Popcorn/WASM 资产。
- 与 Microsoft PowerPoint 像素级完全一致。基础支持矩阵必须明确，复杂 SmartArt、嵌入字体和动画可回退到系统应用，但不得因此删减 Artifact Tab 的交互闭环。

## 五、目标架构

### 5.1 Artifact open target 和 tab 状态

新增类型建议：

```ts
type ArtifactPreviewSource =
  | { kind: "workspace-file"; relativePath: string }
  | { kind: "authorized-local"; sourceId: string };

type ArtifactNavigationTarget = {
  requestId: string;
  artifactKind: "presentation";
  slideNumber?: number;
  slideId?: string;
  objectId?: string;
};

type ArtifactOpenTarget = {
  kind: "artifact";
  artifactType: "slides";
  importKind: "pptx";
  source: ArtifactPreviewSource;
  title: string;
  openSource:
    | "generated-resource"
    | "file-workspace"
    | "inline-link"
    | "composer-attachment"
    | "message-attachment";
  originatingTurn?: {
    threadId?: string;
    turnId?: string;
    messageId?: string;
    inputMessageId?: string;
  };
  attachmentPreview?: {
    origin: "composer" | "sent-message";
    requestId: string;
  };
  navigation?: ArtifactNavigationTarget;
};
```

要求：

- workspace source 的稳定 ID 由 workspace/root 身份和标准化相对路径生成；authorized-local source 由不可猜测 source ID 生成。
- 同一 source 重复打开时复用 tab；如果带新 `navigation.requestId`，更新现有 tabState 并执行一次导航。
- preview tab 被固定后不能被后续 preview 打开降级；继续复用现有 reducer 语义。
- 持久化只保存可序列化、非敏感状态；不得保存任意绝对路径或 composer 一次性发送 token。

### 5.2 ArtifactPreviewSourceService

新建 Artifact 专用 shared/preload/main API，避免为了 PPTX 放宽通用 Files 读取面：

```text
window.desktopApp.workspace.artifacts
  ├─ registerWorkspaceSource(relativePath)
  ├─ registerAuthorizedLocalSource(previewCapability)
  ├─ readMetadata(sourceId)
  ├─ readBinary(sourceId, maxBytes)
  ├─ watch(sourceId)
  ├─ createComposerAttachment(sourceId)
  └─ release(sourceId)
```

安全要求：

- workspace source 仍通过 owned root + `realpath` + 相对路径约束，可抽取复用 `FileWorkspaceService` 的安全 resolver，但不复制一份稍有差异的实现。
- 用户本地附件由 picker 在返回 composer capability 的同时签发单独的 Artifact preview source；发送用的一次性 capability 和预览 source 生命周期互不消费。
- renderer 后续只传 source ID；main 保存 path、文件 identity、来源和有效期，并在每次读取时复核 identity。
- 附件 Artifact Tab 也必须支持跨重启恢复：source manifest 以应用私有存储持久化，设置有效期和孤儿回收；若来源已移动或 identity 不匹配，恢复为明确的“源不可用”，绝不回退为读取同路径的新文件。
- `readBinary` 必须实际最多读取 `maxBytes + 1`，不能只做 `stat <= maxBytes` 后调用无界 `readFile()`。
- checksum 使用读取到的真实 bytes 计算；同路径同 size/mtime 但内容变化也必须使缓存失效。
- “添加到会话上下文”时由 main 为同一 source 创建新的、用途受限的 attachment reference，不暴露路径或复用旧发送 token。

### 5.3 Renderer 解析器与能力闸门

依赖候选优先使用当前官方 PPTX-only 包 `@file-viewer/renderer-pptx`；旧的 `@file-viewer/renderer-presentation/pptx` 只作为兼容事实，不作为新实现默认。正式接入前必须完成 Phase 0 能力闸门。

Phase 0 必须用固定版本的公开 API 证明：

1. React 19、Electron dev/build/packaged 环境均可离线加载 Worker。
2. 能获得稳定 slide 列表、当前 slide、slide ID 和总页数。
3. 能通过公开 API 选择 slide、zoom、fit、销毁/替换文档，并监听状态变化。
4. 能截获用户触发的 hyperlink，不会自动联网或执行危险 scheme。
5. 能获得批注所需的稳定 element ID、element frame/hit target，或能从公开 presentation model 可靠推导。
6. 能按 slide ID、slide number、object ID 实现目标定位。
7. 解析可取消，重复挂载和 Strict Mode 不泄漏 Worker/observer/object URL。
8. parser 对 ZIP 条目数、展开后大小、压缩比、关系链接和 XML 资源有可验证的安全上限。

选择顺序：

1. 标准 React renderer + PPTX-only renderer 满足全部要求：直接使用。
2. UI renderer 不足，但同项目公开 engine/model API 能满足：在单一 adapter 内使用公开 engine，宿主自建 panel。
3. 公开 engine 仍无法提供稳定对象几何/批注目标：实现仓库内只读 OOXML Worker/model，支持本计划固定的 PPTX 子集，并保留系统应用回退。

禁止做法：

- 用未公开 DOM class、Shadow DOM 内部结构或 monkey patch 充当核心协议。
- 因候选 renderer 只能显示页面，就删除对象导航或批注验收项。
- 从参考包中抽取 Walnut、Popcorn 或私有 worker。
- 通过远程转换服务、CDN Worker、`unsafe-eval` 或扩大通用本地文件权限完成门禁。

如果三条路线都无法满足公开可维护实现和安全要求，计划在 Phase 0 判定为阻塞，不能把降级的 Files 预览宣布为完成。

### 5.4 宿主 PresentationPanel

无论底层 parser 选择哪条路线，Artifact 用户体验由本项目宿主层控制：

- 统一 `PresentationDocument` model：slides、stable slide ID、elements、stable object ID、frames、links、render source。
- 固定 slide rail、选中状态、当前页/总页数、上一页/下一页、键盘导航、zoom in/out/reset/fit。
- navigation command 有 request ID 去重，可按 slide number、slide ID 或 object ID 定位；object 定位后给出短暂高亮。
- 宽屏 `>=749px` 为 220px rail；`<=748px` 为可展开的浮动 rail；`<=688px` 为堆叠页布局。阈值和行为对齐，视觉使用本项目设计 token。
- speaker notes、编辑、下载、导出和打印控件不出现在 Artifact PPTX panel。
- hyperlink 只在用户点击后处理；仅 `http:`/`https:` 交给现有安全外链 API，其余 scheme 拒绝。
- 解析或渲染失败时保留 Artifact header 和系统打开/reveal 回退，不白屏、不无限 loading。

### 5.5 AnnotationReviewLayer

批注层建立在稳定 presentation model 上，不耦合第三方 renderer 内部 DOM：

- 目标类型：整张 slide、具体 element、用户框选 region。
- region 坐标保存为相对 slide 的归一化坐标；缩放和响应式布局后仍定位正确。
- marker 使用稳定 annotation ID 和本次会话内编号；选择 marker 打开编辑器。
- 保存模式产生结构化 composer context，至少包含 source、title、slide ID/number、object ID 或 normalized region、正文和 originating turn。
- 更新/dismiss 同步 panel、ArtifactTab state 和 composer 中尚未发送的对应 context。
- direct submit 通过现有 conversation follow-up/steer 入口提交一次，并携带稳定 session annotation ID 做去重。
- 附件预览、无活动本地会话或不支持的上下文中禁用 review tools；普通会话 Artifact 才启用。
- 关闭 tab 时取消并清理未保存编辑器/待提交 annotation，不静默发送内容。

### 5.6 ArtifactConversationBridge

`ArtifactTabContent` 位于 `AssistantRuntimeProvider` 外，不能直接调用 `useAui`。在 `ConversationWorkspaceLayout` 以上建立显式 bridge，由活动会话 pane 注册以下能力：

- `addArtifactAnnotationToComposer(context)`
- `updatePendingArtifactAnnotation(id, context)`
- `dismissPendingArtifactAnnotation(id)`
- `submitArtifactAnnotationDirect(context)`
- `attachArtifactSource(sourceId)`

bridge 必须绑定当前 thread/conversation identity；会话切换后拒绝旧 Artifact 的 direct submit，或要求 opener 的 originating turn 与当前会话匹配。源变化时清除旧 originating-turn 关联，避免把批注发给错误文件或错误会话。

## 六、可测试验收标准

### A. Artifact surface 与入口

- **AC-01**：仅大小写不敏感的 `.pptx` 分类为 `artifactType='slides'`、`importKind='pptx'`；`.ppt`、`.pptm`、`.ppsx` 和伪装扩展名不进入该分支。
- **AC-02**：对话生成资源卡、文件链接和 Files 中的 `.pptx` 打开 `kind='artifact'` 标签，而不是普通 `file` 预览；其他文件类型行为不变。
- **AC-03**：composer 和已发送消息中的本地 PPTX 附件可打开 attachment Artifact preview，并保存 `origin` 与唯一 `requestId`；预览就绪/失败均结束对应请求状态。
- **AC-04**：同一 source 使用稳定 tab ID；重复打开不产生副本，携带新 navigation 时更新并激活现有 tab。
- **AC-05**：preview replacement、pin、激活、关闭和 right/bottom 移动遵循现有 workspace 语义；固定 tab 不被后续 preview 降级。
- **AC-06**：普通 Artifact header 提供“添加到会话上下文”、使用系统应用打开、在 Finder 中显示/复制相对路径等适用动作；附件 preview 隐藏重复的“添加”动作。
- **AC-07**：应用重启后恢复 Artifact tab、panel 位置、pin 和必要导航状态；授权已失效或文件缺失时显示可操作错误，不读取替代路径。

### B. 读取、授权和缓存

- **AC-08**：先读取 metadata；大于 `40 * 1024 * 1024` 的 PPTX 在创建 parser/Worker 前显示 too-large。
- **AC-09**：实际二进制读取最多请求 `limit + 1` 字节；精确 limit 成功、limit+1 失败，且 stat 后文件增长的 TOCTOU 用例仍不能把超限内容读入 renderer。
- **AC-10**：workspace source 不能越过 owned root；authorized-local 只能由 picker/capability 注册；绝对路径、`..`、反斜杠、symlink 逃逸、伪造/过期 source ID 全部被拒绝。
- **AC-11**：checksum/cache 以真实 bytes 为准；同路径同 size/mtime 的内容替换会重新解析，旧 source、旧解析 Promise 或旧 Worker 结果不能覆盖新文档。
- **AC-12**：文件 watch 检测到源变化后刷新 metadata/bytes/cache，并使旧 originating-turn/annotation target 失效或显式重新绑定。

### C. PPTX 显示与导航

- **AC-13**：真实中文/英文、多页 PPTX 能在独立 Artifact panel 显示第一张 slide、slide rail、当前页和总页数，且不自动打开系统应用。
- **AC-14**：按 slide number、slide ID 和 object ID 的 navigation target 均可定位；同一 request ID 只执行一次，对象定位后有可见高亮。
- **AC-15**：点击缩略图、上一页/下一页和键盘导航保持主视图、rail 选中态与页码一致。
- **AC-16**：zoom in/out/reset/fit 由 viewer/model controller 驱动；标签切换或 resize 后保持合法 zoom/fit 状态。
- **AC-17**：`>=749px` 为固定 220px rail，`<=748px` 为浮动/折叠 rail，`<=688px` 为堆叠页；right/bottom 两种工作区都无不可恢复横向溢出。
- **AC-18**：所有导航、zoom、rail 和错误回退控件都有中文可访问名称、可见焦点态、disabled 状态；键盘用户可以完整操作只读预览。
- **AC-19**：PPTX 内链接只有用户点击后才处理；`http:`/`https:` 走现有安全外链 API，`file:`、`javascript:`、data URL、自定义 scheme 和自动跳转被拒绝。
- **AC-20**：speaker notes 和编辑能力隐藏；基础文本、中文、图片、形状、表格和基础图表 fixture 可读，超出保真矩阵的内容明确回退而非伪装成功。

### D. Artifact annotations 与会话闭环

- **AC-21**：review tools 只在普通 Artifact + 有效当前会话中启用；standalone、附件 preview、已切换会话或无 originating context 时禁用。
- **AC-22**：用户可为 slide、element 和框选 region 建立批注；marker、编辑器和高亮在缩放、切页和 resize 后仍定位正确。
- **AC-23**：保存模式向 composer 加入结构化 context，包含 source/title/slide/object 或归一化 region/body/originating turn；不会直接发送消息。
- **AC-24**：修改或 dismiss 未发送批注时，panel marker、tabState 和 composer context 同步更新/移除，不产生孤儿 context。
- **AC-25**：direct submit 通过现有 follow-up/steer 路径恰好提交一次；重复事件、重挂或重试用 session annotation ID 去重，不绕过聊天链路。
- **AC-26**：关闭 tab 或源变化会放弃并清理未完成编辑器和 pending annotations，记录必要状态但绝不静默发送。
- **AC-27**：普通 Artifact header 的“添加到会话上下文”生成新的受限 attachment reference；不会泄露绝对路径或复用已经消费的一次性 capability。

### E. 生命周期、离线、安全和性能

- **AC-28**：快速打开 A/B、关闭 tab、切换 source、工作区卸载和 React Strict Mode 重挂时，旧结果不回写；Worker、observer、timer、订阅和 object URL 均清理。
- **AC-29**：dev、production build 和 packaged app 均从本地同源加载 parser、Worker、样式和字体；断网可预览，没有 CDN/GitHub/unpkg/jsDelivr 请求。
- **AC-30**：损坏 ZIP、缺少关键 OpenXML 部件、加密/密码保护、Worker 初始化失败、解析失败和渲染失败均显示中文错误及系统打开回退，不白屏或无限 loading。
- **AC-31**：真实 20 页、10 MiB 以内 fixture 在 CI Electron runner 5 秒内显示首张 slide；解析期间标签切换、关闭和系统打开按钮保持响应，tab 切换反馈不超过 500ms。
- **AC-32**：接近 40 MiB 的合法 fixture 不发生超过 `limit+1` 的单次文件读取；记录首屏时间和 renderer RSS 增量，目标 RSS 增量不超过 350 MiB，超标则阻止发布或降低已声明上限。
- **AC-33**：zip bomb、高条目数、异常压缩比、XML entity、恶意 relationship、外部资源和脚本链接 fixture 被安全拒绝或隔离；CSP 不增加远程 host、`unsafe-eval` 或泛化本地文件读取。
- **AC-34**：依赖精确锁版本，记录 LICENSE/NOTICE、peer dependency、发布完整性、`npm audit` 和 bundle 体积；构建产物缺少 Worker/样式/manifest 引用时门禁失败。
- **AC-35**：现有 file/review/terminal/browser workspace、文本/Markdown/图片/PDF、资源卡片和聊天发送/steer 流程保持通过；app-server、provider fork 和推理链路零改动。

## 七、实施步骤

### Phase 0：锁定能力闸门，先证明“能完整复刻”

目标文件：

- `desktop-app/package.json`
- `desktop-app/package-lock.json`
- `desktop-app/electron.vite.config.ts`
- 新增隔离 PoC：`desktop-app/src/renderer/src/components/artifacts/presentation/rendererCapability.test.tsx`
- 新增决策记录：`desktop-app/docs/artifact-pptx-renderer-decision.md`

动作：

1. 用官方当前文档/发布包核对 PPTX-only renderer、engine、Worker 和许可证，精确锁定候选版本。
2. 用真实 fixture 依次验证第五节的八项公开 API/安全能力，覆盖 dev、production 和 packaged Electron。
3. 记录标准 renderer、公开 engine 和仓库内 OOXML adapter 三条路线的证据，不以类型声明或 demo 截图代替运行结果。
4. 最终文档明确选择、拒绝理由、版本、公开 API、Worker 路径、对象 ID/geometry 来源、zip 安全边界和 bundle 体积。

硬停止条件：无法通过公开、可维护且安全的接口获得 slide/object/geometry、导航、取消和安全上限。此时不得进入 UI 集成，也不得删除 AC-14 或 AC-22 来制造“通过”。

### Phase 1：锁定 Artifact workspace 合同

目标文件：

- `desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts`
- `desktop-app/src/renderer/src/components/workspace-container/workspaceTypes.ts`
- `desktop-app/src/renderer/src/components/workspace-container/workspaceReducer.test.ts`
- `desktop-app/src/renderer/src/components/workspace-container/workspacePersistence.test.ts`

动作：

1. 先写失败测试，覆盖 stable ID、重复打开更新 navigation、preview/pin、持久化和 source 不可用恢复。
2. 新增 `ArtifactOpenTarget`、可序列化 `ArtifactTabState` 和纯函数 classifier/descriptor factory。
3. 明确 migration/version 策略；generic persistence 虽能保存任意 kind，仍要验证旧版本数据和敏感字段过滤。

完成条件：AC-01、AC-04、AC-05、AC-07 的 reducer/persistence 部分通过。

### Phase 2：实现 ArtifactPreviewSource 安全协议

建议新增：

- `desktop-app/src/shared/artifactPreviewApi.ts`
- `desktop-app/src/shared/artifactPreviewApi.test.ts`
- `desktop-app/src/main/artifacts/ArtifactPreviewSourceService.ts`
- `desktop-app/src/main/artifacts/ArtifactPreviewSourceService.test.ts`
- `desktop-app/src/main/artifacts/registerArtifactPreviewIpc.ts`
- `desktop-app/src/preload/artifactPreviewApi.ts`

需要小范围抽取/复用：

- `desktop-app/src/main/rightWorkspace/FileWorkspaceService.ts`
- `desktop-app/src/main/localPathCapabilityStore.ts`
- `desktop-app/src/main/localContextPicker.ts`
- `desktop-app/src/preload/index.ts`

动作：

1. 定义 source register/metadata/read/watch/attachment/release 的 Zod schema 和 versioned response union。
2. 抽取共享的安全路径/identity 验证，不放宽通用 Files API 的 byte limit。
3. 实现 workspace source 与 authorized-local source 两条注册路径；本地附件 preview source 与发送 token 分离。
4. 实现 metadata + `maxBytes+1` 硬读取、SHA-256、watch generation、TTL/孤儿回收和恢复校验。
5. 实现 `createComposerAttachment(sourceId)`，只返回现有聊天入口可消费的受限引用。

完成条件：AC-08 至 AC-12、AC-27 的 main/shared 测试通过，包括 limit+1、TOCTOU、symlink、伪造 ID、identity replacement 和 restart restore。

### Phase 3：注册独立 Artifact Tab

建议新增：

- `desktop-app/src/renderer/src/components/artifacts/ArtifactTabContent.tsx`
- `desktop-app/src/renderer/src/components/artifacts/ArtifactTabContent.test.tsx`
- `desktop-app/src/renderer/src/components/artifacts/artifactTabDescriptor.tsx`
- `desktop-app/src/renderer/src/components/artifacts/useArtifactSource.ts`

修改：

- `desktop-app/src/renderer/src/components/workspace-container/WorkspaceContentRegistry.tsx`
- `desktop-app/src/renderer/src/components/right-workspace/RightWorkspaceProvider.tsx`
- `desktop-app/src/renderer/src/App.tsx`

动作：

1. 在 registry 注册 `artifact` kind 和生命周期 adapter；不把 PPTX 细节写入通用 workspace controller。
2. 构建 Artifact header、metadata/loading/too-large/error 状态、context menu、attachment request 完成状态和 system-open/reveal 回退。
3. source generation 变化时取消旧读取/解析、清理旧 annotation/originating context 并刷新。
4. close lifecycle 统一处理 pending annotation、Worker 和 source lease。

完成条件：独立 Artifact Tab 可以在没有 presentation renderer 的 stub 下完成打开、恢复、关闭和错误生命周期；AC-03 至 AC-07 的 shell 部分通过。

### Phase 4：接通所有 PPTX 入口

目标文件：

- `desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx`
- `desktop-app/src/renderer/src/components/render-units/renderUnitDetails.test.tsx`
- `desktop-app/src/renderer/src/components/right-workspace/files/FileWorkspace.tsx`
- composer/已发送附件 tile 的实际组件与测试（实施时先用 `rg` 精确定位，不在计划中猜文件名）

动作：

1. 生成资源卡和对话内 `.pptx` 链接改为构造 artifact target，并携带 open source/originating turn。
2. Files 仍负责浏览，但打开 `.pptx` 时转交 Artifact Tab；其他 file tab 行为不变。
3. picker 为 PPTX 附件签发 preview source ID；composer/消息附件点击打开 attachment preview 并传 correlation request ID。
4. 所有入口共用 classifier 和 opener，禁止分别实现互不一致的扩展名/ID/导航逻辑。

完成条件：AC-01 至 AC-05 的入口 E2E 通过，`.pptx` 不再落入普通 binary unsupported 分支。

### Phase 5：实现 presentation parse/cache adapter

建议新增：

- `desktop-app/src/renderer/src/components/artifacts/presentation/presentationTypes.ts`
- `desktop-app/src/renderer/src/components/artifacts/presentation/PresentationRendererAdapter.ts`
- `desktop-app/src/renderer/src/components/artifacts/presentation/presentation.worker.ts`
- `desktop-app/src/renderer/src/components/artifacts/presentation/presentationCache.ts`
- 对应 unit/integration tests

动作：

1. 按 Phase 0 选型把 bytes 转换为统一 `PresentationDocument`，第三方类型不泄漏到 ArtifactTab/annotations。
2. cache key 包含 source identity、generation 和真实 checksum；缓存保存可安全复用的 model，不复用已销毁 controller。
3. 使用 Worker 和 generation/cancellation protocol；late result 必须丢弃。
4. 对 ZIP/OpenXML 安全上限、外部 relationship、字体/图片资源和 object ID 稳定性增加 fixture。

完成条件：AC-11、AC-28 至 AC-33 的 parser/worker 部分通过。

### Phase 6：实现宿主 PresentationPanel

建议新增：

- `desktop-app/src/renderer/src/components/artifacts/presentation/PresentationPanel.tsx`
- `desktop-app/src/renderer/src/components/artifacts/presentation/PresentationSlideRail.tsx`
- `desktop-app/src/renderer/src/components/artifacts/presentation/usePresentationController.ts`
- `desktop-app/src/renderer/src/components/artifacts/presentation/PresentationPanel.css`
- 对应 component tests

动作：

1. 实现 rail、selected slide、page count、prev/next、keyboard、zoom/reset/fit 和 loading/error。
2. 实现 navigation request 去重、slide/object 定位与高亮。
3. 用 container queries 对齐 749/688 阈值和 220px rail；right/bottom 都验证。
4. 通过宿主处理 hyperlink，保持 notes/editing 隐藏和可访问性。

完成条件：AC-13 至 AC-20 全部通过，不依赖第三方私有 DOM 选择器。

### Phase 7：实现 AnnotationReviewLayer

建议新增：

- `desktop-app/src/renderer/src/components/artifacts/annotations/AnnotationReviewLayer.tsx`
- `desktop-app/src/renderer/src/components/artifacts/annotations/ArtifactAnnotationEditor.tsx`
- `desktop-app/src/renderer/src/components/artifacts/annotations/artifactAnnotationTypes.ts`
- `desktop-app/src/renderer/src/components/artifacts/annotations/artifactAnnotationReducer.ts`
- 对应 reducer/component tests

动作：

1. 实现 slide/element/region target、normalized geometry、marker/editor 和 resize/zoom 映射。
2. 实现保存、直接提交、update、dismiss 事件与稳定 annotation ID。
3. 根据 attachment preview、当前 conversation 和 originating turn 计算 `annotationsEnabled`。
4. close/source-change lifecycle 放弃未完成 annotation，不发送消息。

完成条件：AC-21、AC-22、AC-24、AC-26 的纯 UI/state 部分通过。

### Phase 8：建立 ArtifactConversationBridge

建议新增：

- `desktop-app/src/renderer/src/components/artifacts/ArtifactConversationBridge.tsx`
- `desktop-app/src/renderer/src/components/artifacts/ArtifactConversationBridge.test.tsx`

修改：

- `desktop-app/src/renderer/src/App.tsx`
- 当前 composer/follow-up/steer 封装所在文件

动作：

1. provider 放在 conversation workspace 与 Artifact panel 都能访问的位置；活动会话 pane 注册具体动作。
2. 保存模式创建/更新/dismiss composer context；direct mode 复用现有 follow-up/steer 和去重机制。
3. 严格校验当前 conversation identity、source generation 和 originating turn，拒绝陈旧请求。
4. 接通 header 的 attach artifact action。

完成条件：AC-23 至 AC-27 全部通过，并有“切换会话后旧 Artifact 不误发”的回归测试。

### Phase 9：真实 fixture、产物和 Electron E2E

建议新增/修改：

- `desktop-app/tests/fixtures/presentations/basic-cn.pptx`
- `desktop-app/tests/fixtures/presentations/navigation-objects.pptx`
- `desktop-app/tests/fixtures/presentations/malformed.pptx`
- `desktop-app/tests/fixtures/presentations/security/*`
- `desktop-app/tests/e2e/artifact-pptx.e2e.ts`
- `desktop-app/tests/test-plan-coverage.json`
- `desktop-app/scripts/verify-pptx-worker-bundle.mjs`
- packaged/offline smoke 脚本
- `desktop-app/package.json`

动作：

1. fixture 覆盖中文/英文、图片、形状、表格、基础图表、对象链接、多页导航、损坏/加密和恶意 OpenXML；记录生成方式、许可证和 SHA256。
2. E2E 覆盖所有入口、preview/pin、right/bottom、恢复、navigation、zoom、responsive、hyperlink、annotation saved/direct/update/dismiss、source change 和 close cleanup。
3. 给 AC-01 至 AC-35 对应的关键场景分配稳定测试 ID，并登记到 `test-plan-coverage.json`；覆盖门禁只登记真实断言和已运行证据。
4. production/packaged request 监听证明 Worker/字体/图片均为本地资源；离线重复执行。
5. bundle verifier 检查 parser chunk、Worker、样式和 manifest 引用；故意移除 Worker 时脚本必须失败。
6. 运行 20 页和接近 40 MiB fixture 的首屏、交互和 RSS 测量，保存基线。

完成条件：AC-28 至 AC-35 全部有自动化或可重复产物证据。

## 八、测试与验证顺序

按依赖顺序运行，前置失败不得跳到后续宣布成功：

1. Phase 0 Electron capability gate。
2. Shared/source security：
   - `npm --prefix desktop-app run test:unit -- src/shared/artifactPreviewApi.test.ts`
   - `npm --prefix desktop-app run test:unit -- src/main/artifacts/ArtifactPreviewSourceService.test.ts`
3. Workspace/open target/persistence：
   - 运行 workspace reducer、registry 和 persistence 目标测试。
4. Renderer model/panel/annotations/bridge：
   - 运行 `src/renderer/src/components/artifacts/**` 目标测试。
5. 入口非回归：
   - 运行 render units、Files、composer 和消息附件目标测试。
6. 静态检查：
   - `npm --prefix desktop-app run lint`
   - `npm --prefix desktop-app run typecheck`
7. Production 产物：
   - `npm --prefix desktop-app run build`
   - `npm --prefix desktop-app run verify:pptx-worker-bundle`
8. Artifact PPTX Electron E2E：
   - `npm --prefix desktop-app run test:e2e -- tests/e2e/artifact-pptx.e2e.ts --reporter=line`
9. Packaged/offline/security/performance smoke。
10. 测试覆盖登记门禁：
    - `npm --prefix desktop-app run test:plan-coverage`
11. 完整 desktop 回归：
    - `npm --prefix desktop-app test`

若本机无法运行 packaged smoke，必须记录具体环境缺口；真实 production Electron E2E、Worker URL 断言和 bundle verifier 是最低替代证据，但仍不得表述为 packaged 已通过。

## 九、主要风险与处理

| 风险                                             | 影响                                             | 处理                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 标准 renderer 只能显示页面，无法提供稳定对象模型 | object navigation 和 element annotation 无法完成 | Phase 0 先验证；必要时用公开 engine 或仓库内 OOXML adapter，不删验收项                                  |
| 参考项目使用私有 Walnut/Popcorn                  | 直接复制存在许可证、ABI、维护和安全风险          | 只复刻可观察行为，建立本项目 model/panel/annotation 层                                                  |
| 40 MiB base64 造成多份内存                       | renderer 峰值过高或卡顿                          | 硬读取、单活跃 parser、及时转移/释放 buffer、RSS 门禁；超标则重新设计传输或降低已声明能力，不能静默 OOM |
| stat 与 read 竞态                                | 超限文件可能被完整读入                           | 实际 `maxBytes+1` bounded read，stat 只用于提前提示                                                     |
| 本地附件授权跨重启                               | 泄露任意路径或恢复错误文件                       | 独立 source ID、identity 复核、TTL、私有 manifest、孤儿清理                                             |
| Artifact panel 在 AssistantRuntimeProvider 外    | 批注保存/直提无法调用会话                        | 显式 conversation bridge，绑定当前 conversation identity                                                |
| 恶意 PPTX/zip bomb/外部关系                      | CPU、内存、XSS 或意外联网                        | Worker、解压上限、关系白名单、CSP、恶意 fixture；安全上限不可验证则阻止选型                             |
| Electron packaged Worker 路径失效                | dev 正常、安装包白屏                             | capability gate + local workerUrl + bundle verifier + packaged/offline smoke                            |
| 来源更新后批注仍指向旧对象                       | 错误上下文被发送                                 | checksum/generation 绑定 annotation；源变更使旧 target 和 originating turn 失效                         |
| 入口各自生成不同 tab ID/上下文                   | 重复标签、恢复和导航不一致                       | 单一 classifier + opener + descriptor factory                                                           |
| 参考归档无 raw mirror                            | 证据精度低于新解包标准                           | 保留 beautified 行号/SHA，明确证据等级；后续有 raw 时补充而非改写历史                                   |

## 十、开发提交建议

1. `test(artifact): lock pptx artifact tab contracts`
2. `build(artifact): prove and pin pptx renderer capability`
3. `feat(artifact): add secure preview source service`
4. `feat(workspace): register durable artifact tabs`
5. `feat(artifact): route pptx resources and attachments`
6. `feat(artifact): add presentation parser and panel`
7. `feat(artifact): add review annotations`
8. `feat(artifact): bridge annotations into conversation`
9. `test(artifact): cover packaged offline pptx parity`

每个提交只跨越一个可审查边界，并运行直接相关测试；source 安全、renderer 依赖、UI 和 conversation bridge 不压成一个大提交。

## 十一、完成定义

只有同时满足以下条件，才能宣称“完整复刻参考项目的 Artifact Tab PPTX 实现”：

- AC-01 至 AC-35 全部通过，没有以“第三方库不支持”为由豁免 Artifact 导航或批注能力。
- `.pptx` 从生成资源、Files、链接、composer 和消息附件均进入独立 Artifact Tab。
- stable tab、preview/pin、right/bottom、恢复、附件 correlation、originating turn 和 navigation target 行为完整。
- 40 MiB gate、`maxBytes+1` 硬读取、source authorization、checksum/cache/source-change 和 cancellation 有安全测试。
- rail、选中页、页码、slide/object navigation、zoom/fit、响应式、链接、隐藏 notes 和错误回退可用。
- slide/element/region annotation 的保存、直提、更新、dismiss、关闭清理和会话身份校验形成闭环。
- dev/build/packaged/offline 均能加载本地 Worker；恶意文档、性能和内存门禁通过。
- lint、typecheck、目标单测、Artifact E2E、完整 desktop 回归和可运行的 packaged smoke 有新鲜证据。
- app-server、provider fork、审批和模型推理链路零改动，renderer 仍不能直接读取 Node/fs 或任意绝对路径。
- 依赖版本、许可证、审计、bundle 体积、fixture 来源、支持矩阵和已知保真限制都有记录。

若最终只完成“Files 中显示 PPTX、翻页和缩放”，应明确标记为局部预览能力，不能按本计划关闭“完整 Artifact Tab PPTX 复刻”目标。
