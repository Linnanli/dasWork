# 36412021750 校准与视觉复查

- 校准：[36412021750](https://github.com/Linnanli/dasWork/actions/runs/36412021750)，四平台 native build / P3 自动门禁通过。
- 提交：`84732005a79c559c2111b1764efc0a13d0ca2cc8`。
- 预算提取：[36417936943](https://github.com/Linnanli/dasWork/actions/runs/36417936943)，通过。
- [回执核对结果](audit-summary.json)：四平台归档身份与原生报告绑定、48 张旧/新 PNG 哈希与尺寸、48 个真实迁移场景、100 条隔离 OfficeCLI 命令及四份内存回执均已核对。
- 大 Runtime ZIP 未在本机下载或重新计算哈希；归档身份来自 CI 原生验证与 provenance 链。本地小文件按 ZIP 长度/CRC 提取，再核对各回执中的 SHA-256。

## 视觉复查：未接受

旧/新六页 PNG 的机器取证完整，用户人工接受仍未完成。独立视觉审查确认 Linux 第 5 页缺少图表分类和图例的中文文字；图柱和数值正常，因此既有整页像素门槛未拦住这个问题。其他三平台未见同等级内容丢失，Windows 全尺寸截图已恢复。新旧字体粗细与文字布局仍有差异，不能将它们当作完全一致的渲染。

| 平台 | 六页对比总览 | 原尺寸旧/新图片 |
| --- | --- | --- |
| darwin-x64 | [对比](darwin-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | `darwin-x64/r07-visual/{legacy-slides,slides}/slide-01.png` 至 `slide-06.png` |
| darwin-arm64 | [对比](darwin-arm64/r07-visual/r07-preview-comparison-contact-sheet.png) | `darwin-arm64/r07-visual/{legacy-slides,slides}/slide-01.png` 至 `slide-06.png` |
| win32-x64 | [对比](win32-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | `win32-x64/r07-visual/{legacy-slides,slides}/slide-01.png` 至 `slide-06.png` |
| linux-x64 | [对比](linux-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | [旧图表](linux-x64/r07-visual/legacy-slides/slide-05.png)、[缺字的新图表](linux-x64/r07-visual/slides/slide-05.png) |

对比总览的差异列显示 `dimension mismatch`，原因是旧图为 1921×1080、新图为 1920×1080；该列未生成热图。逐页数值已按旧图尺寸缩放计算，尺寸与原图片未改写，实际审查使用旧、新图片。

## 独立预算审查

审查者：只读子 agent `/root/budget_review_36412021750`。审查对象：[实测报告](review/performance-report.json)、[候选预算](review/runtime-budget-candidate.json) 与当前公式及三个锁文件。

- 四平台 archive/unpacked 各 5 份；disk、overlap、cold、p99、max delay 各 10 份。
- run、source/installer commit、三个锁哈希和 fingerprint `47aba1ed4f0024fd6d76063320ea7fec5cef0baffe331a2583600edc34571893` 匹配。
- 候选与现有生成函数输出一致；转换正式 schema、补 reviewed 和四归档哈希后验证通过，所有实测均在候选预算内，未改硬上限。
- macOS 首次安装/事件循环延迟存在尖峰，10 样本下 p95 为最大值，当前候选已覆盖；darwin-x64 冷安装预算 50,657ms、事件循环最大延迟 408ms，arm64 为 19,552ms / 405ms。Windows 为 10,045ms / 37ms，Linux 为 13,329ms / 58ms。

本轮预算数值审查通过，但视觉修复改变桌面提交后需重新校准和审查；未把这个候选写入正式 `runtime-budgets.json`，未启动 final，也未接受 A6/A9。

## 修复后的本机控制与回归

Main 现在同时处理 SVG `text/tspan` 的继承字体，并追加 Runtime Noto；页面脚本、网络、Node 和资源限制保持原设置。实际缺字图与正常图已进入测试 fixture，新增 R07 门禁仅检查固定第 5 页的三个文字区域，并保留原整页非白与颜色门槛。

- [实际区域测量](chart-label-control-metrics.json)：Linux 缺字图三个区域比率为 `0 / 0.0001806 / 0`，新门禁拒绝；三个非 Linux 原生完整图均通过。
- [本机控制上下文](local-chart-font-control/control-context.json)、[真实字体/窗口报告](local-chart-font-control/font-layout-report.json)、[修复后图表 PNG](local-chart-font-control/slide-05.png)：使用此运行的 Linux PPTX，真实 Mac Electron 六页均输出 3840×2160，图表 15 个 SVG 文字节点带 Runtime 字体；三个区域为 `0.0277842 / 0.0383625 / 0.0177469`，新门禁通过。
- 独立只读代码审查 `/root/office_exec_audit_windows` 未发现字体优先级、安全边界或门禁接入阻塞。区域检查只证明固定 R07 标签区域有文字，不能替代逐页内容与布局审查。
- 23 个相关单元测试、44 个发布契约测试、10 个 Runtime 预算/硬上限测试通过；桌面完整 build 与 Node/Web typecheck 通过；完整 lint 为 0 错误、539 个既有警告；原生运行时边界、bundled plugins 和 diff 检查通过。发布契约首次因沙箱禁止监听本地端口失败，允许本地 HTTPS 服务后全量 44 项通过。

此控制主机为 darwin-x64，原生 Linux 修复仍待新的四平台校准，视觉验收仍未接受。
