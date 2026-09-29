# 36512308682：四平台校准、实图与预算证据

- 校准：[36512308682](https://github.com/Linnanli/dasWork/actions/runs/36512308682)，四平台 native build / P3 全部通过。
- 提交：`48e1a5ed1095a536e4c8b492065536dfcc5af47e`。
- 小型预算证据提取：[36517699704](https://github.com/Linnanli/dasWork/actions/runs/36517699704)，通过。
- [来源审计](audit-summary.json)：四目标归档与原生回执绑定、48 张旧/新 PNG 哈希与尺寸、48 个迁移场景、100 条隔离 OfficeCLI 命令、四份安装内存回执均核对通过。
- 四目标 Runtime 清单均选择 `fonts/noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf`，输入文件 SHA 为 `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`；源锁 SHA 为 `5fd22c6ac0a33ad47d98b5cd8a748afbd33dd1c9e3cc93df9bba21a18bd0601d`。
- 大 Runtime ZIP 未在本机下载或重算哈希；归档身份来自 CI 原生验证及 provenance 链。小型文件按 ZIP 字节范围提取，核对长度、CRC，再按回执核对 SHA-256。

## 原图视觉审查：未发现阻塞回归，用户接受仍待完成

根侧逐对查看 darwin-x64 的十二张原图；只读子 agent 查看另外三平台全部三十六张原图。中文、表格文字与 `46%`、图表标题/两个分类/图例/`18.4`/`37` 均可见，新版第六页流程图和中文正文完整。未见缺字、方框、空白页或整页裁切复发。报告见 [macOS Intel](darwin-x64-visual-review.json) 和 [另外三平台](three-platform-visual-review.json)。

新版字号、字体粗细、换行和局部位置与旧版有差异，整体内容更收缩；不宣称旧新像素或布局完全一致。darwin-x64 旧第六页原图的图片区域为空，新版图像可见。旧 PNG 是 1921×1080，新 PNG 是 1920×1080；contact sheet 的 delta 列显示 dimension mismatch，审查使用原图，原文件尺寸未改写。

| 目标 | 六页对比总览 | 重点原图 |
| --- | --- | --- |
| darwin-x64 | [对比](darwin-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | [表格](darwin-x64/r07-visual/slides/slide-04.png)、[图表](darwin-x64/r07-visual/slides/slide-05.png) |
| darwin-arm64 | [对比](darwin-arm64/r07-visual/r07-preview-comparison-contact-sheet.png) | [表格](darwin-arm64/r07-visual/slides/slide-04.png)、[图表](darwin-arm64/r07-visual/slides/slide-05.png) |
| win32-x64 | [对比](win32-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | [表格](win32-x64/r07-visual/slides/slide-04.png)、[图表](win32-x64/r07-visual/slides/slide-05.png) |
| linux-x64 | [对比](linux-x64/r07-visual/r07-preview-comparison-contact-sheet.png) | [表格](linux-x64/r07-visual/slides/slide-04.png)、[图表](linux-x64/r07-visual/slides/slide-05.png) |

机器回执和独立 agent 审查不替代用户人工接受；原 comparison report 的 `visualAcceptance=pending/accepted=false` 保留。工程 final 验证仍待进行，完整 A1–A9 尚未接受。

## 实测与候选预算

四目标各有 5 份 build/unpack 与 10 份真实 Main 聊天/安装重叠样本。所有样本保留，来源、三锁 SHA、四候选归档及测量 fingerprint 绑定于原始报告。未修改预算公式、硬上限或测试样本。

| 目标 | 最大冷安装 / 候选上限（ms） | 最大 p99 / 候选上限（ms） | 最大延迟 / 候选上限（ms） |
| --- | --- | --- | --- |
| darwin-x64 | 50143 / 62679 | 13 / 17 | 1478 / 1848 |
| darwin-arm64 | 13274 / 16593 | 18 / 23 | 468 / 585 |
| win32-x64 | 10108 / 12635 | 7 / 9 | 59 / 74 |
| linux-x64 | 12385 / 15482 | 4 / 5 | 25 / 32 |

darwin-x64 第一个冷安装样本为 50,143ms，第二个 Main 最大延迟样本为 1,478ms；两者不是同一次样本。十样本的 p95 采用最大值，候选包含尖峰，并未删除或平滑。报告只记录安装窗口内的延迟，不能据此归因于 CI 宿主，也不能证明不存在客户端性能问题。该目标 p99 样本为 9–13ms，十次普通聊天均在安装完成前结束。

独立预算审查及最终工程 Feed 的后续状态以本轮验收记录为准。
