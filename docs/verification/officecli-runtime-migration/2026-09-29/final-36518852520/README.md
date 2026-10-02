# 36518852520：最终工程与用户视觉验收完成

- [最终运行](https://github.com/Linnanli/dasWork/actions/runs/36518852520)：success，2026-09-29 04:38:02 UTC 完成。
- 最终构建提交：`7612f7dfbcd8529c469efbc0b7672dd17446b3b8`；已独立审查的校准：`36512308682`。
- A1–A9 已全部验收完成；[用户人工视觉接受](user-visual-acceptance.json)来自本任务明确答复。
- [原生来源审计](native-audit-summary.json)、[工程 Feed/预览审计](feed-audit-summary.json)、[三个工程门禁复验](release-gate-verification.json)均通过。
- [独立只读设计复核](final-acceptance-review.json)未发现工程验收设计阻塞。

## 四平台最终原生证据

每目标目录保留来源、SBOM、v3 清单、输入清单、离线 smoke、平台验证、迁移、安装内存、构建/解包、正式预算及校准报告。源锁、字体、预算和回执 SHA 已逐项绑定。共 48 个真实迁移场景、100 条隔离 OfficeCLI 命令与网络/执行正反探测通过；v3 技能为 officecli，旧 Runtime presentation-skill 已停用，回滚恢复旧能力。

| 目标 | 最终归档字节 | 解包字节 | 安装 RSS 增量字节 | 上限字节 |
| --- | --- | --- | --- | --- |
| darwin-x64 | 116313335 | 174667526 | 47144960 | 402653184 |
| darwin-arm64 | 115377512 | 173626168 | 88850432 | 402653184 |
| win32-x64 | 112773705 | 162905404 | 52371456 | 402653184 |
| linux-x64 | 179820975 | 351018995 | 45522944 | 402653184 |

最终归档及解包大小在正式预算内；校准冷安装/事件循环尖峰原样保留，详见[校准与预算审查](../calibration-36512308682/README.md)。

## 最终 R07 实图与用户接受

开发版和打包版分别从同一签名工程 Feed、空缓存启动。实际 app-server 的技能/loader/命令/文件/预览链、来源/generation/receipt 与 PPTX SHA 已绑定；`AT-E2E-01`、`AT-LIVE-01`、`AT-LIVE-PKG-01` 在本机重新核验通过。

两组十二张 PNG 的 SHA、1920×1080 尺寸及原像素/图表文字区域门槛均通过；两组逐页字节一致。根侧逐页查看六张唯一原图，中文、表格 `46%`、图表分类/图例/`18.4`/`37` 和流程图完整，未见缺字、方框、空页或裁切。[agent 实图审查](visual-review.json)与[用户明确接受](user-visual-acceptance.json)分别保存；原始机器及 agent 回执保持生成时状态。

- [开发版六页总览](feed/evidence/r07-visual-dev/r07-contact-sheet.png)
- [打包版六页总览](feed/evidence/r07-visual-packaged/r07-contact-sheet.png)
- 打包版原图：[封面](feed/evidence/r07-visual-packaged/slides/slide-01.png)、[议程](feed/evidence/r07-visual-packaged/slides/slide-02.png)、[摘要](feed/evidence/r07-visual-packaged/slides/slide-03.png)、[表格](feed/evidence/r07-visual-packaged/slides/slide-04.png)、[图表](feed/evidence/r07-visual-packaged/slides/slide-05.png)、[流程图](feed/evidence/r07-visual-packaged/slides/slide-06.png)。
- 四平台旧/新比较已在[校准证据](../calibration-36512308682/README.md)逐页审查；字号、换行和局部位置差异已告知用户并接受。

## 证据与发布边界

最终产物明确 `engineeringOnly=true`、`productionTrust=false`、`publiclyDeployable=false`，本轮完成工程验证，未进行生产发布。测试使用确定性外部模型替身，证明真实桌面/app-server 执行链，不证明真实模型自主遵守技能。

签名校验由 CI 和实际安装链完成；本机复核配置/清单 payload、四平台归档与门禁绑定。临时公钥未随 Feed 留存，未在本机独立重验签名。大 Runtime ZIP 未下载或本机重算哈希；归档身份来自原生 CI 验证和 provenance。小型证据与 PNG 按 ZIP 字节范围提取、核对长度和 CRC 后，按回执核对 SHA。

[files.json](files.json)记录本目录除索引自身以外的文件字节数与 SHA-256。最终构建仍绑定上述提交；后续文档归档提交不改变验证对象。[总验收记录](../../../officecli-runtime-migration.md)汇总 A1–A9 状态与历史修复。
