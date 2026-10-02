# 36420932977：Linux 缺字失败与 SVG 解码修复控制

日期：2026-09-29

## 运行与输入

[校准运行 36420932977](https://github.com/Linnanli/dasWork/actions/runs/36420932977) 绑定提交 `45a4e151b3e83c772f3ff58ae83756cde29377fd`。四目标原生构建成功，三个非 Linux 目标 P3 成功；Linux P3b 在真实 PNG 检查失败，第 4 页颜色桶为 12，原门槛要求大于 12。第 4 页表格文字消失，第 5 页中文分类、标题和图例消失。运行状态见 [failed-run.json](failed-run.json)，原始失败图片见 [表格](ci-linux-failure/slide-04.png) 和 [图表](ci-linux-failure/slide-05.png)。

`source/r07-presentation.pptx` 来自失败诊断工件 `10971346516`，SHA-256 为 `6ce32767eb414d612ac7f43ed966e35d04f166b9029120aa4fd546baad1a1a61`。同一 PPTX 用锁定的 OfficeCLI 1.0.152 生成六份 SVG。Linux 原生二进制输出与控制输入只差首尾空白，逐页来源、二进制及字体哈希见 [control-summary.json](control-summary.json)。

## 根因与实现

直接运行旧 Main 的 Linux 控制复现了相同缺字，见 `linux-before/`。诊断确认：表格字体已经加载，但窗口截图可能在文字绘制前完成；图表仍选择前面的系统字体，增加等待也不会恢复中文。先前尝试的 offscreen 首帧方案在完整 Linux/macOS 复验中仍产生纯色/缺字页，因此没有提交该方案。

最终实现删除窗口截图和 compositor 首帧依赖。Main 在隔离文档内准备字体与文本样式，序列化完整 SVG，等待 `Image.decode()`，在明确尺寸的 HTML canvas 上先画白底再绘制图像，导出 PNG；Main 继续检查 PNG 解码、空图和尺寸。文档脚本、Node、权限、打开窗口和外部资源访问仍受原来的限制。[decode 文档](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode) 说明其 Promise 在图像数据可用后完成；[drawImage 文档](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage) 说明图像到画布的绘制接口。实际 `foreignObject`、中文和内嵌图片兼容性由本次六页产物证明。

字体使用独立的 `Dascowork Preview CJK` 名称，只覆盖 CJK/全角字符，优先于系统字体；Latin 字符继续采用文档原字体。Runtime 来源锁明确选 `NotoSansCJKsc-Regular.otf`、400、normal，构建与输入验证复用同一精确路径，缺失时失败。旧构建按文件名排序选到了 Black；此前 Mac 控制使用 Regular，不能视为旧 Runtime 实际字体依赖的等价证明。本次明确记录两种字体哈希，新原生 Runtime 清单仍待新校准验证。

## 结果与边界

| 控制 | 真实 PNG | 原整页与三个图表文字区域门槛 |
| --- | --- | --- |
| 旧 Main，Linux | 6 页 | 失败：表格无字，图表中文标签消失 |
| 修复后，Linux | 6 页，1920×1080 | 全部通过 |
| 独立重跑，Linux | 6 页，1920×1080 | 全部通过，六页 SHA 与前一轮逐页相同 |
| 修复后，macOS x64 | 6 页，1920×1080 | 全部通过 |

Linux 第 4 页颜色桶恢复为 68。第 5 页三个文字区域的深色像素比为 `0.023669554455445545`、`0.026463150289017343`、`0.004148148148148148`，原门槛 `0.003`、`0.003`、`0.001` 保持。所有逐页实测见 [slide-metrics.json](slide-metrics.json)。修复后的 Linux 两轮和 Mac 图片直接调用实际 Main，未插入截图 hook、CDP 查询或诊断延时。原生 Electron Linux ZIP 与 OfficeCLI 二进制均核对官方/来源锁 SHA；Linux 控制主机为 Debian 13，不是 CI 的 Ubuntu 宿主。

辅助字体诊断在完整 PNG 已生成后读取 DOM/CDP 信息，见 `linux-fonts-slide-04.json`、`linux-fonts-slide-05.json`；中文选中 `NotoSansCJKsc-Regular`，`46%` 及图表数字采用 Liberation Sans/Serif。该辅助诊断不作为画面完成条件。Linux 六页实图已由 agent 检查，四目标原生实图及人工接受仍待新校准。

本地验证：预览、服务和原图片测量共 27 项通过；Runtime 77 项通过、4 项因平台不符跳过；发布契约 44 项通过。完整桌面构建及 Node/Web 类型检查、原生运行时边界、bundled plugins 和 diff 检查通过。完整 lint 为 0 错误、539 条既有警告，变更 TypeScript 文件单独 lint 无输出。

本记录不代表完整 A1–A9 接受。仍需绑定新源锁哈希的四目标 calibrate、真实 Regular 清单、逐页实图复审、独立预算审查，以及 final 打包和签名工程 Feed 门禁。文件哈希索引见 [files.json](files.json)。
