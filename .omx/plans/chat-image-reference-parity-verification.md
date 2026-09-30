# 聊天图片对齐验收记录

日期：2026-09-29。关联：[实施计划](/Users/nallylin/Documents/code/dasCowork/.omx/plans/chat-image-reference-parity-plan.md)。状态：代码与适用环境验收完成；真实 Electron 两份聊天测试全部通过，截图与摘要见文末。

## 实际实现

- Main 新增受校验的图片来源解析和保存 API，复用既有 `app://fs` 流式文件协议。归属来自消息对应的会话/线程，不以当前项目代替旧线程目录。
- Markdown 地址按来源规则解码一次；原生 `imageView.path` 保持字面路径。实际 Streamdown 流程会处理本地 URL，因此在图片节点进入清理插件前保留合法来源，之后恢复；链接仍使用原来的处理逻辑。
- 聊天正文、Agent 查看记录、输入附件、已发送附件、生成图片共用加载/失败组件与大图弹窗。沿用 assistant-ui 消息和附件体系，通用图片入口不构造虚假 image part。
- Agent 查看记录留在过程区中，采用两层折叠、展开后才读取缩略图。标题固定按 item ID 计数；同路径不同调用分别计数，不推断工具成功或历史失败。
- 大图支持适应窗口、参考缩放档位、指针锚点缩放、平移、多图切换、键盘关闭与原始字节保存。弹窗持有来源，关闭触发图片条不会提前释放 File URL。
- preload 请求与返回校验显式关闭 Zod 动态编译，严格 CSP 下不使用 `unsafe-eval`。图片 CSP 增加 `http:`，使计划内 HTTP 图片与现有 HTTPS 图片使用同一加载方式。
- Windows 原始反斜杠路径在 Markdown 中会成为 `C:%5C...`；Renderer 保留这种图像来源，Main 在显式 Windows 平台下解码一次。原生文件名里的字面 `%5C` 不变。
- 历史 `localImage` 附件从真实 path 恢复文件名和具体图片 MIME。协议没有记录原始名字的 data/远程 image 不补造文件名。
- 新建持久线程使用原生 `historyMode: 'paginated'`。独立真实 app-server 的完整历史页返回 imageView ID/path 后，再由已有 mapper 展示；临时线程和旧线程恢复沿用各自原生契约。

主要文件：

- [Main 图片能力](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/chatImages/ChatImageService.ts)、[HTTP 保存](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/chatImages/ChatImageDownloads.ts)、[shared contract](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/shared/chatImageApi.ts)。
- [共享图片组件](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/images/ChatImage.tsx)、[来源状态](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/images/chatImageSource.ts)、[大图弹窗](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/images/ImagePreviewDialog.tsx)。
- [Markdown 图片入口](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/markdownChatImage.tsx)、[图片查看记录](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/components/render-units/imageViewActivity.tsx)、[消息分组](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/renderer/src/lib/assistantRenderUnits.ts)。

## A1–A15 证据索引

| 项目 | 已有验证 | Electron 复验状态 |
| --- | --- | --- |
| A1/A2 来源与编码 | `ChatImageService.test.ts` 的真实磁盘/平台参数表；实际 Streamdown 的 `markdownChatImage.test.tsx`；生成图片接 Main 的解码测试。 | 通过：PNG/JPEG 实际解码、绝对/file/sandbox/相对路径、中文空格和字面百分号。 |
| A3 消息归属 | 服务测试验证旧线程目录、会话绑定、远程目标拒绝；缓存键包括归属。 | 通过：两项目切换、旧历史重载。 |
| A4 状态与竞态 | 来源 hook 与 Dialog 测试覆盖延迟、失败、旧响应、卸载、坏图像。 | 通过：真实缺失文件、403/404、坏图像。 |
| A5 有限复用 | 同来源并发只解析一次，50 次文本更新不重读，不同归属隔离，最后消费者离开 15 秒释放；未提交渲染也释放缓存。 | 单元测试验证调用数与时钟，无须用界面截图替代。 |
| A6 两层折叠 | App 完整消息测试与 render-unit 测试覆盖 final 开始、用户展开、无 final 停止/失败、明确取消与强制展开；图片记录默认收起。 | 通过：真实 `view_image`、final 流式开始、停止、重载。 |
| A7/A15 固定计数与协议 | render-unit/摘要测试覆盖 ID 去重、同路径不同调用、分隔、原始信息、历史 id/path；原生 id/path 计数映射保留。 | 通过：同路径两个真实调用、缺失文件仍为 2。独立 app-server 完整历史页有 2/1 条原始 imageView，重载 UI 有对应记录。 |
| A8 消息内画廊 | 实际 Markdown 渲染的 DOM 顺序、ready 筛选、两消息隔离与点击 index；附件与生成列表也有对应测试。 | 通过：从 A 消息中图打开、B 消息不混入。 |
| A9 缩放 | 几何及 Dialog 测试覆盖 fit ≤ 100%、参考档位、最小/最大比例、切图与窗口变化。 | 通过：真实弹窗缩放与切图。 |
| A10 锚点/平移/触摸 | 几何、Dialog 指针测试覆盖锚点、普通滚轮、单指平移和双指缩放。 | 通过：Electron 鼠标、锚点误差 ≤ 2 CSS px、CDP 双指输入；触摸硬件未验证。 |
| A11 焦点/键盘 | Dialog 测试验证 Esc、关闭后焦点、键盘范围、可编辑控件。 | 通过：Electron 焦点与方向键。 |
| A12 保存 | Main 测试覆盖原始字节、取消、失败、窗口销毁；HTTP 测试覆盖来源关联、重定向、并发、同来源串行与清理。 | 通过：真实 DownloadItem、本地/data/HTTP 保存 SHA256 相同，取消、中断失败及重试完成。 |
| A13 附件 | adapter/picker 既有测试及新附件测试保留选择、粘贴、拖入、移除、MIME、发送与 File 生命周期。 | 通过：两附件预览、模型收到 PNG bytes、发送及重载保留文件名。 |
| A14 生成图片 | 6 项集成测试覆盖 4 个缩略图/完整画廊、生成状态、file/sandbox 解码、拒绝任意 blob/非图像 data。 | 使用相同已验证大图组件；生成工具协议未改。 |

## 命令结果

| 检查 | 结果 |
| --- | --- |
| `npm --prefix desktop-app run build` | 所有最终代码修订后重新执行通过，包含 node/web 类型检查与生产构建。 |
| 图片 Main/preload 定向测试 | preload 禁用 Function 构造器回归和 Main 相关 49 项通过；修复前能复现 CSP 字符串代码生成失败。 |
| 图片展示层测试 | 来源、几何和 Dialog 38 项通过。 |
| render-unit/摘要既有与新增测试 | 154 项通过。 |
| 实际 Markdown 与链接回归 | 24 项通过。 |
| Windows Markdown 修订后的图片/链接回归 | 实际 Streamdown、来源分类、链接、行内代码 30 项通过；Main 来源参数及相关回归 92 项通过。 |
| 历史附件名称与 MIME | mapper、ThreadClient、ConversationApi、媒体 URL 46 项通过。 |
| 最终版本受影响测试集合 | 19 个文件、419 项全部通过，含完整 App、Main/IPC/preload、图片组件、历史 mapper 与 NativeDriver。 |
| `verify:real-codex-app-server-contract` | 通过，真实 runtime 能力/协议检查成功。 |
| 附件/生成图片接入 | 原定向集合 27 项通过；file/sandbox 修订后的生成图片 6 项通过。 |
| `npm --prefix desktop-app run lint` | 0 个错误；539 个仓库已有格式警告。新增 preload 与 E2E 文件另行 lint 通过。 |
| `npm --prefix desktop-app test` | 2647 项通过，3 项跳过，10 项失败。9 项由沙箱拒绝本地 socket 造成，退出沙箱定向复验 11 项全部通过；剩余插件排序用例独立复验仍失败，详见下文。所有此次受影响图片/附件/App 测试通过。 |
| `test:release-contract` | 43/44 通过；1 项本地 HTTPS 监听被沙箱拒绝。该文件退出沙箱复验 4/4 通过。 |
| `test:reference-analysis` | 10/10 通过。 |
| `test:codex-verifiers` | 23/23 通过。 |
| `verify:codex-native-runtime-boundaries` | 通过，无边界违规。 |
| `verify:codex-app-server-protocol-contract` | 通过，锁定协议与 runtime 版本/hash 一致。 |
| 参考索引完整校验 | 7188/7188 文件、200 条位置记录通过；排版前原包不可用，保留 `beautified-fallback` 标注。 |
| `git diff --check` | 通过。 |
| 两份聊天 Electron E2E | 最终 14/14 通过，耗时 1.7 分钟；包括新增 5 项图片测试和既有 9 项聊天回归。真实 app-server 为 `codex-cli 0.148.0-alpha.21`。 |

最终 Electron 命令（在 desktop-app 目录，先完成生产构建）：

```sh
npm exec -- playwright test tests/e2e/chat-images.e2e.ts tests/e2e/chat.e2e.ts --reporter=line --output=/private/tmp/dsc-chat-image-final-e2e
```

最终 419 项受影响测试命令（在 desktop-app 目录）：

```sh
npx vitest run src/main/chatImages src/shared/chatImageApi.test.ts src/preload/chatImageCsp.test.ts src/main/conversations/CodexHistoryUiMessageMapper src/main/codexRun/NativeCodexRunDriver.test.ts src/renderer/src/components/images src/renderer/src/components/render-units/markdownChatImage.test.tsx src/renderer/src/components/render-units/imageViewActivity.test.tsx src/renderer/src/components/render-units/generatedImagePreview.test.tsx src/renderer/src/components/assistant-ui/attachment.test.tsx src/renderer/src/lib/assistantRenderUnits.test.ts src/renderer/src/lib/toolGroupSummary.test.ts src/renderer/src/lib/toolActivityDisplay.test.ts src/renderer/src/lib/referenceInlineTarget.test.ts src/renderer/src/App.test.tsx
```

## 验证限制与已有失败

- 当前 macOS 环境没有运行 Windows 实机；Windows 路径由显式平台参数测试覆盖。
- 指针/双指输入由组件及 Chromium 输入事件覆盖，未验证触摸硬件。
- 既有 `PluginCenterPage.test.tsx` 的 `matches the reference installed-plugin count and ordering` 在全量及独立复验均失败：期望 Bundled 在 Primary runtime 前，实际顺序相反。相关生产文件未在此次修改，记录为既有基线失败。
- 旧 `legacy` 线程的原生历史接口可能不返回已经完成的 imageView；本次不会迁移其模式或从 rollout 拼造 UI 历史。新建持久线程已使用分页契约并验证真实记录；旧消息仍可显示原生接口实际返回的记录和正文图片。
- 最早的 Electron 图片测试揭示 preload Zod 动态代码生成被 CSP 拒绝；已修复并增加严格禁用 Function 的回归测试。最终界面与下载证据以修复后复验为准。

## 界面与下载产物

Root 已查看代表截图，确认正文尺寸、失败占位、两级折叠和近黑色大图布局。8 张截图共约 1.04 MiB；没有将 trace、完整 rollout 或重复附件副本归档。

| 状态 | 截图 |
| --- | --- |
| 正文有效图片 | [正文图片](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/markdown-local-images.png) |
| 缺失、坏图、403、404 | [图片不可用](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/markdown-image-unavailable.png) |
| 大图缩放与切换 | [共享预览](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/image-preview-zoom-and-navigation.png) |
| 查看记录默认收起 | [运行中的图片记录](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/image-view-record-in-running-process.png) |
| final 流式开始后外层收起 | [过程区收起](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/image-view-process-collapsed-during-final.png) |
| 两层展开后的 80px 图片条 | [查看图片缩略图](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/image-view-expanded-thumbnails.png) |
| 无 final 的停止与历史恢复 | [停止后的图片记录](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/stopped-image-view-history-without-final.png) |
| 已发送附件统一预览 | [附件画廊](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/sent-attachment-shared-gallery.png) |

机器可核查的摘要：

- [真实 E2E 命令、结果、范围与限制](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/evidence.json)。
- [原生分页历史与旧 legacy 对照](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/history-evidence.json)。
- [真实下载重定向、中断与重试事件](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/download-evidence.json)。
- [保存文件及截图 SHA256](/Users/nallylin/Documents/code/dasCowork/.omx/plans/assets/chat-image-reference-parity/sha256.json)。

本地、data、HTTP 三份保存文件均为 915246 字节，SHA256 与原始 PNG 相同：

```text
128e76f80d75c7149ef9f419a44fc7f3df387a8a2280c42805c32ff785b8d577
```
