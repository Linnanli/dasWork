# 工作区 PPT 网页预览

日期：2026-09-29。

## 实现

- OfficeCLI 路径只执行一次 `stats` 和一次 `view <file> html --out <output>`，移除逐页 SVG 转 PNG 及隐藏 Electron 窗口截图。
- 一个无脚本的 iframe 展示整份导出的网页，左侧缩略图复用原生网页结构，通过复制幻灯片节点并缩放生成。主视图保持单页显示。
- 保留应用的 220px 缩略图栏、翻页、缩放、窄窗口布局、链接操作，以及页面、元素、区域批注。批注层挂载在缩放后页面的外层，批注标记保持固定大小。
- 本地中文字体在整份网页中只嵌入一次。公式由已有 KaTeX 转为原生 MathML。网页脚本、外部资源和文档导航被移除或阻止。
- 文件更新仍触发重新导出；旧 Runtime 的 LibreOffice 图片预览兼容分支继续保留。
- 主窗口生命周期只在主框架的完整导航时重置工作区，子 iframe 加载或刷新不会清理文件根、预览来源及后续 IPC 操作。采用 Electron 的 [主框架导航标记](https://www.electronjs.org/docs/latest/api/web-contents#event-did-start-navigation)和[逐框架完成事件](https://www.electronjs.org/docs/latest/api/web-contents#event-did-frame-finish-load)。完整客户端测试先发现了该问题：HTML 就绪后添加到会话报工作区不可用；已修复并加入回归检查。

## 同机生成耗时对比

同一 Electron 进程先后运行旧、新服务各一次，使用 OfficeCLI 1.0.152、固定的本地 Runtime 依赖和同一份六页 PPT。

样例：`docs/verification/officecli-runtime-migration/2026-09-29/final-36518852520/feed/evidence/r07-visual-dev/r07-ai-agent-security-market.pptx`，SHA256：`936e52e8d7d948c520aef3908795ea409095ed3f7f7c0f133224c8e2984ffc4d`。

| 服务 | 生成耗时 | 返回内容大小 |
| --- | ---: | ---: |
| 修改前 HEAD `e7661012eacebbebdd11487099658a47a19e399c` | 52,927 ms | 六张 PNG，共 378,985 bytes |
| 网页预览 | 9,550 ms | HTML 22,034,112 bytes，包含中文字体 |

本次样例的生成耗时减少约 82%，约为原来的 1/5.5。计时范围为 `service.render()`，包含临时文件写入、OfficeCLI、旧截图或新字体嵌入、结果校验和清理；源文件从同一份已读入内存的内容返回。**不包含 Runtime 诊断、IPC 或前端展示时间，不代表完整打开耗时，也不是多轮统计。**

临时复现脚本：`/private/tmp/dascowork-ppt-benchmark.cjs`。临时网页：`/private/tmp/dascowork-officecli-six-page-preview.html`。

完整客户端从点击工作区文件到网页字体、图片就绪的独立测量：一页样例 20,720 ms；六页样例 19,232 ms。各测一次，包含依赖准备、IPC 和前端加载，尚未逐阶段拆分。此结果说明生成耗时的 9,550 ms 不能直接当作完整打开时间。

## 验证

- `npm --prefix desktop-app run build` 通过；最终代码的 `electron-vite build` 再次通过。Node、Web 类型检查通过。
- `npm --prefix desktop-app run lint` 通过，0 个错误；仓库现有格式警告未批量修改。
- 服务、旧 Runtime 兼容、Artifact 生命周期、PresentationPanel、HTML 组件与控制器：6 个文件、39 项测试通过。另有 5 项主窗口生命周期测试通过，覆盖子框架加载、同页导航、主框架重载和销毁。
- 真实 Electron 的 HTML 预览测试通过：缩略图和键盘翻页、工具栏、50%/100% 缩放下的固定大小批注、页面/元素/链接操作、宽窄布局、MathML 公式、脚本禁止和 CSP 外部资源阻止。宽窄截图已查看。
- 完整客户端的一页及真实六页 PPT 通过 Renderer → Preload → Main → OfficeCLI 的公开 IPC 验证：原生缩略图逐页点击、中文表格及图表、预览后添加会话附件。六页文件替换为一页后，generation 自动更新，主视图和缩略图刷新为一页，公开 `readBinary` 仍可访问。真实表格和图表截图已查看。
- 窄窗口点击第五张缩略图后，只有缩略图栏横向滚动；html、body 和主视图的 `scrollLeft` 均为 0。真实表格与图表标题的横坐标一致，未发现主画面随缩略图滚动而裁剪。
- 区域批注通过派发 PointerEvent 验证 iframe 内拖选和移至父文档后的释放、归一化坐标。此环境的 Electron/CDP 在最简无事件监听 iframe 中也会卡住原生鼠标拖动，故原生跨 iframe 拖选仍有自动化覆盖缺口。
- PPTX worker bundle、10 项参考分析检查、23 项协议和边界检查通过。发布检查 43 项通过，另 1 项因沙箱不允许监听本地 HTTPS 端口而失败；在允许本机监听的环境重新执行对应迁移文件，4 项全部通过。

全量 `npm test` 的 Vitest 阶段：2499 项通过、28 项失败、3 项跳过。失败主要为默认 5 秒超时、本地 socket 沙箱限制、旧的测试样式加载问题及未改动的插件排序断言。重新执行相关预览测试后全部通过；解除本地 socket 限制并将并发限制为 2 后，工具调用和多项界面测试通过，但插件排序断言及少数未改动的超时用例仍失败。全量测试未宣称通过，未修改无关测试或扩大默认超时。
