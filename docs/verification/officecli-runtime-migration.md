# OfficeCLI Runtime 迁移验收记录

日期：2026-09-28

计划：`.omx/plans/2026-09-27-officecli-office-capability-migration.md`

## 复审结论

**尚未完成全部计划验收。** 以下历史运行证明了当时的构建、安装和桌面调用链，不能证明本轮工作区修改已经通过四平台验收。旧 R07 把非白像素比例和颜色数量写成固定值，未测量真实 PNG，因此撤回“视觉验收已完成”的结论。

| 条件 | 当前状态 | 尚缺的证据 |
| --- | --- | --- |
| A1：固定版本与四平台供应链 | 主要实现已完成，已有历史构建记录 | 本轮技能及验证逻辑修改后的新归档和来源回执 |
| A2：干净、离线三格式验证 | 已增加复杂文档、网络阻断和系统程序执行检查；本机 darwin-x64 实际验证通过 | 其余原生平台的执行排除探测及三格式实际结果 |
| A3：v3 清单及 v1/v2 兼容 | 已实现 | 与本轮真实四平台归档一起复验 |
| A4：健康 Runtime 路径及能力发布 | 已实现，回归验证通过 | 四平台技能同步失败后的真实能力记录 |
| A5：技能、插件与 Runtime 整体切换 | 已补事务内同步、整体恢复和启动恢复顺序；本地回归通过 | 实际 v2→v3、冷启动、失败恢复与回滚矩阵 |
| A6：六页真实 PNG 预览 | 已替换固定指标，逐页测量和哈希检查已实现；白图、损坏图回归通过 | 新的真实 R07 运行、旧/新逐页对比及视觉检查 |
| A7：三格式技能与命令结果检查 | 已实现；复杂 DOCX/XLSX 副本编辑本机通过 | 四平台实际执行记录 |
| A8：生产路径退役旧插件 | 新 v3 清单已移除，旧格式兼容保留 | 冷启动时仅退役受管插件的真实记录 |
| A9：全部门禁及性能预算 | 历史记录保留，本轮尚未完成 | 新校准、独立预算审查和最终构建/打包门禁 |

本轮新增的迁移测试使用真实旧 v2 归档、签名 HTTPS Feed 和真实 app-server；预览对比已接入同一个原生校准任务，保留逐页 PNG、图片哈希、比较报告和对比图。测试代码已接入并不表示测试已执行通过。

离线 smoke 使用临时用户目录和受限环境，先验证网络连接正向对照成功且隔离后失败，再检查系统程序执行：macOS 仅允许 OfficeCLI 绝对路径执行；Linux 在网络隔离内以 strace 逐次核对 execve/execveat；Windows 在 CreateProcessW 启动时设置禁止创建子进程策略。正反探测必须实际执行，缺少工具或不完整记录均失败。本机 macOS 已证明系统 shell 在对照组可启动、受限组被拒绝，并在相同策略下完成真实 OfficeCLI 命令。其余平台尚未实际运行，A2 继续保持未验收。

本轮本地验证：桌面针对性回归 7 个文件、94 项通过；Runtime 测试 72 项通过，Linux/Windows 原生探测 2 项因主机平台不同跳过；发布流程测试 43 项通过；架构及发布证据检查测试 23 项通过。静态类型检查通过，lint 为 0 个错误、540 项现有格式警告。本机真实隔离 smoke 的 25 条 OfficeCLI 命令通过，其中三格式 smoke 为 24 条；每条执行记录与命令、退出码逐一对应，网络隔离结果为 `EPERM`，原始记录见[darwin-x64 验证回执](officecli-runtime-migration/2026-09-28/darwin-x64-officecli-isolated-smoke.json)。未执行新的四平台真实迁移、旧/新预览对比和最终打包验收。

旧/新预览报告保留原始尺寸，并按相同尺寸计算逐页像素差异；允许不同像素密度造成的边缘取整，不允许幻灯片比例改变。报告明确标记 `visualAcceptance.status=pending`、`accepted=false`。取得四平台真实图片后，仍需逐页检查中文、布局、表格和图表，才能接受 A6。

## 历史实现与验证版本

- OfficeCLI：`v1.0.152`；四个平台的原生工件由 `primary-runtime/runtime-sources.lock.json` 锁定来源、版本、SHA-256 和许可证。
- 实现提交：`a77bf65f`；跨平台构建修复：`41e7917f`；审查预算：`0a572f60`；Feed/发布证据契约修复：`a688d1d6`；安装内存证据保存：`31638612`。
- [四平台校准运行 36324310893](https://github.com/Linnanli/dasWork/actions/runs/36324310893)：成功。
- [预算证据提取运行 36326535499](https://github.com/Linnanli/dasWork/actions/runs/36326535499)：成功。候选预算经独立审查，再以 `reviewed: true` 写入 `primary-runtime/runtime-budgets.json`。
- [最终运行 36361322781](https://github.com/Linnanli/dasWork/actions/runs/36361322781)：成功；构建和验证提交为 `316386121eb1747ca03328414279e34eae0008cc`。

## 已落地的能力

- Primary Runtime v3 提供 OfficeCLI、独立 OfficeCLI 技能、Poppler 和字体；Office 能力不再要求 Runtime Node、Python、npm 包、LibreOffice 或 `presentation-skill` 插件。
- Main 诊断和 loader 发布经过验证的 OfficeCLI 绝对路径。v3 技能同步及 app-server reload 未完成时，新 thread 不发布 loader。
- DOCX、XLSX、PPTX 的离线读取、创建、修改副本、保存及验证进入四目标 smoke；原件哈希检查保留。
- PPTX 预览由 OfficeCLI 导出逐页 SVG，再由隔离的 Electron Chromium 离线生成 PNG；页码、sourceId、generation 和对象标注协议保持兼容。
- 旧 Runtime 插件退役和托管技能替换只处理能够确认由 Runtime 管理的内容；旧 v1/v2 清单读取和 LibreOffice 预览路径保留用于兼容与回滚。
- Feed 接受无补丁的 OfficeCLI 来源证明；发布证据绑定源锁和目标原生工件，不再读取旧插件的 sourceArchive/patch 字段。

## 历史四平台结果与性能证据

四个平台均通过最终原生构建、归档/平台/解包/硬限制校验、真实安装及安装内存压力测试。最终构建绑定已审查的校准预算。

| 目标 | 最终 Runtime ZIP 字节数 | 校准冷安装最大样本 | 已审查冷安装预算 | 最终 staging 证据 |
| --- | ---: | ---: | ---: | --- |
| darwin-x64 | 116,311,292 | 32,840 ms | 41,050 ms | [artifact 10946395382](https://github.com/Linnanli/dasWork/actions/runs/36361322781/artifacts/10946395382) |
| darwin-arm64 | 115,375,276 | 10,012 ms | 12,515 ms | [artifact 10945098640](https://github.com/Linnanli/dasWork/actions/runs/36361322781/artifacts/10945098640) |
| win32-x64 | 112,771,718 | 10,180 ms | 12,725 ms | [artifact 10945024205](https://github.com/Linnanli/dasWork/actions/runs/36361322781/artifacts/10945024205) |
| linux-x64 | 179,817,955 | 13,315 ms | 16,644 ms | [artifact 10945544579](https://github.com/Linnanli/dasWork/actions/runs/36361322781/artifacts/10945544579) |

冷安装数据来自校准运行，每目标有十次真实 Main 安装/普通聊天重叠样本；归档和解包大小每目标有五次样本。预算按仓库公式留出余量，绑定源锁、工具链锁、硬限制、测量指纹及候选归档哈希。

每个最终 staging 的文件目录及 `install-stress-memory.json` 已直接读取核对。报告绑定最终版本和归档 SHA-256，并记录基线 RSS、峰值 RSS、增量及上限。原始报告保存在本目录下，数值如下：

| 目标 | 安装测试宿主峰值 RSS | RSS 增量 | 原始报告 |
| --- | ---: | ---: | --- |
| darwin-x64 | 104.07 MiB | 44.11 MiB | [JSON](officecli-runtime-migration/2026-09-28/darwin-x64-install-stress-memory.json) |
| darwin-arm64 | 163.36 MiB | 89.91 MiB | [JSON](officecli-runtime-migration/2026-09-28/darwin-arm64-install-stress-memory.json) |
| win32-x64 | 109.30 MiB | 50.09 MiB | [JSON](officecli-runtime-migration/2026-09-28/win32-x64-install-stress-memory.json) |
| linux-x64 | 117.27 MiB | 42.66 MiB | [JSON](officecli-runtime-migration/2026-09-28/linux-x64-install-stress-memory.json) |

安装测试每 25 ms 采样测试宿主 RSS，并检查增量不超过 384 MiB。这是采样峰值，不表示整台桌面应用所有进程的内存总量。

最终 Runtime ZIP SHA-256：

| 目标 | SHA-256 |
| --- | --- |
| darwin-x64 | `211b691d7092bc85e9d95c8cb4a2c4d769cf6bd4917e457dbd4041002094f5e8` |
| darwin-arm64 | `97b2d83b8e5cd318f8a8cc984ae6060b30a62a0a069bab6733ec827d69b2faf9` |
| win32-x64 | `e1b880c07e21ec1de1bb8bf4dc865de87b43891f4d0bbe6f09ab1f4462fb05cd` |
| linux-x64 | `53095fa08990f88aaf88fe73b84b56ce77214c40b815449f0dbef692195c4f41` |

## 历史签名 Feed 与桌面链路

[最终汇总任务](https://github.com/Linnanli/dasWork/actions/runs/36361322781/job/108740805874) 的所有必需步骤通过：

- 同一运行的四目标来源证明重新验证、工程元数据签名、Feed 汇总。
- 开发版 R07：从签名 Feed 安装，通过真实 Renderer → IPC → Main → Codex app-server → 正常命令生成六页 PPTX，并验证技能、loader、文件和逐页预览。
- Linux 打包版 R07：从空缓存执行相同链路，测试通过。
- `AT-E2E-01`、`AT-LIVE-01`、`AT-LIVE-PKG-01` 证据验证通过，绑定最终提交及实际打包资源 SHA-256；资源回执位于汇总产物的 `evidence/app-tools-release/reports/packaged-app-assets.json`。
- 私钥排除检查通过。

上述 R07 运行可以作为命令和业务链路的历史证据；其固定像素指标不能作为真实 PNG 非空、中文布局或旧/新预览质量的验收依据。

产物：[primary-runtime-engineering-feed](https://github.com/Linnanli/dasWork/actions/runs/36361322781/artifacts/10945933437)。此产物按工作流契约标记为 engineering-only、productionTrust=false、publiclyDeployable=false。

端到端测试使用确定性外部模型响应，证明桌面和 Runtime 命令路径；不将它当作真实模型始终遵循技能说明的证据。四平台桌面开发版 R07 位于校准运行；最终打包版 R07 在 Linux 执行。

## 本地验证与兼容范围

- Runtime：51 项测试通过。
- Feed：18 项发布契约测试和 15 项开发 CLI 测试通过。
- 发布证据：5 项测试通过；工作流：6 项测试通过；最终 release contract：40 项测试通过。
- Desktop typecheck 通过；完整 lint 退出码为 0，存在 546 条格式警告、0 个错误。
- 运行时架构边界、app-server 协议契约、bundled plugins 检查通过。
- 迁移期间 Desktop 全量单元结果：2,465 项通过；9 项受本地沙箱监听端口限制。对应两份测试文件在允许本地端口的环境重跑，11 项全部通过。
- 归档篡改、缺失二进制/技能、v1/v2/v3 清单兼容、旧预览、技能 reload 失败、托管技能恢复和原子激活指针恢复有单元/真实归档测试覆盖。

以上记录保留各证据的实际范围；公开发布仍由仓库既有的生产信任、桌面签名和 App Tools 发布门禁决定。
