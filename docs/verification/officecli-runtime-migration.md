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
| A6：六页真实 PNG 预览 | 本机真实 R07、逐页实测与哈希检查通过；白图、损坏图及交互回归通过 | 新四平台真实 R07、旧/新逐页对比及视觉检查 |
| A7：三格式技能与命令结果检查 | 已实现；复杂 DOCX/XLSX 副本编辑本机通过 | 四平台实际执行记录 |
| A8：生产路径退役旧插件 | 新 v3 清单已移除，旧格式兼容保留 | 冷启动时仅退役受管插件的真实记录 |
| A9：全部门禁及性能预算 | 历史记录保留，本轮尚未完成 | 新校准、独立预算审查和最终构建/打包门禁 |

本轮新增的迁移测试使用真实旧 v2 归档、签名 HTTPS Feed 和真实 app-server；预览对比已接入同一个原生校准任务，保留逐页 PNG、图片哈希、比较报告和对比图。测试代码已接入并不表示测试已执行通过。

离线 smoke 使用临时用户目录和受限环境，先验证网络连接正向对照成功且隔离后失败，再检查系统程序执行：macOS 仅允许 OfficeCLI 绝对路径执行；Linux 在网络隔离内以 strace 逐次核对 execve/execveat；Windows 在 CreateProcessW 启动时设置禁止创建子进程策略。正反探测必须实际执行，缺少工具或不完整记录均失败。本机 macOS 已证明系统 shell 在对照组可启动、受限组被拒绝，并在相同策略下完成真实 OfficeCLI 命令。其余平台尚未实际运行，A2 继续保持未验收。

本轮本地验证：桌面针对性回归 7 个文件、94 项通过；Runtime 测试 72 项通过，Linux/Windows 原生探测 2 项因主机平台不同跳过；发布流程测试 43 项通过；架构及发布证据检查测试 23 项通过。静态类型检查通过，lint 为 0 个错误、540 项现有格式警告。本机真实隔离 smoke 的 25 条 OfficeCLI 命令通过，其中三格式 smoke 为 24 条；每条执行记录与命令、退出码逐一对应，网络隔离结果为 `EPERM`，原始记录见[darwin-x64 验证回执](officecli-runtime-migration/2026-09-28/darwin-x64-officecli-isolated-smoke.json)。未执行新的四平台真实迁移、旧/新预览对比和最终打包验收。

旧/新预览报告保留原始尺寸，并按相同尺寸计算逐页像素差异；允许不同像素密度造成的边缘取整，不允许幻灯片比例改变。报告明确标记 `visualAcceptance.status=pending`、`accepted=false`。取得四平台真实图片后，仍需逐页检查中文、布局、表格和图表，才能接受 A6。

## 校准失败与后续修复

提交 `432e0c6e2423151f83961a20c042da7240a67cc3` 的校准运行 [36373185725](https://github.com/Linnanli/dasWork/actions/runs/36373185725) 已失败。macOS 两平台和 Linux 原生构建通过；Windows 输入验证未通过，因此 Windows P3 的缺失构建产物属于后续连带失败。

- Windows：首个进程限制探测在 50 秒后没有输出。helper 已改为有效的可继承 NUL 输入句柄、独立临时目录、有限的终止与等待，并增加阶段日志。禁止子进程策略保留；修复仍需原生 Windows CI 验证。
- macOS：两个目标的迁移测试都报 `unable to verify the first certificate`。迁移 Feed 已复用校准入口的独立 CA 与服务器证书生成器，验证服务器证书链，Main 只信任局部 CA；未关闭 TLS 校验。
- Linux：本机控制复现发现服务复制安装错误时丢失非枚举 `AggregateError.errors`，测试工具因而显示误导性的 `map` 报错。修复错误属性保留后，实际失败是迁移测试错误地要求旧 v2 也遵守 v3 的技能同步工具发布规则；现保留 v2 的既有约定，并继续严格验证 v3。
- 冷启动：真实 app-server 只能从已发现的 marketplace 返回安装状态。原查询没有缓存旧版本的发现目录，无法可靠退役旧插件；现从受管缓存清单声明恢复查询目录，再应用原有安装状态和归属过滤。生产入口和迁移测试使用同一发现逻辑。
- 诊断与清理：失败时保留阶段、堆栈、内部错误和部分迁移记录；临时目录清理不再跟随 app-server 创建的可执行文件符号链接。

本次修复的本地检查：桌面 5 个文件、82 项测试通过；发布契约 44 项通过（包括独立 CA/服务器证书的实际 HTTPS 握手与拒绝未受信任证书）；Windows helper 检查 8 项通过，原生 Windows 探测 1 项因主机平台不同跳过。类型检查、变更文件 lint、运行时架构边界、bundled plugins 和 diff 检查通过。

本机 darwin-x64 的迁移控制验证已通过 12 个场景：初装 v2、下载中断、Feed 不可用、技能同步/reload/插件退役三类故障、切换 v3、冷启动退役、两轮恢复保留 v2 并再次切换 v3。该验证使用真实 app-server、签名 HTTPS Feed 和临时小归档，证明迁移流程和普通聊天；不替代 CI 的历史完整 v2 与本轮完整 v3 产物验证。测试用本地模型服务明确绕过主机代理，未更改生产代理策略。

四平台真实迁移、预览图片及最终发布预算仍待新的校准与审查，不能根据本地控制样本宣布 A1–A9 完成。

修复提交 `26a06788e6fd4299a53c6c43cedc23c19a633473` 已推送。新的四目标 `calibrate` 运行 [36376506303](https://github.com/Linnanli/dasWork/actions/runs/36376506303) 于 2026-09-28 04:09:29 UTC 创建，已确认 `in_progress` 且绑定该提交。按约定在此暂停，等待用户告知运行完成，再读取真实产物与校准结果。

用户随后报告该运行报错，继续检查发现 Windows 原生构建的输入验证失败：无子进程限制的对照已通过，受限 PowerShell 对照以 `-1073741502`（`0xC0000142`）退出且没有探测输出。这不是成功的拒绝证据，Windows A2 继续保持未验收；Windows P3 因缺少本轮构建产物连带失败。其余三平台的原生构建已通过，后续 P3 在此次检查时仍运行中。继续修复受限探测程序，保持命令执行限制与正反对照要求。

后续检查已确认 macOS 两目标和 Linux 的完整旧 v2→本轮 v3 真实迁移步骤全部通过；Linux 的诊断回执保留 12 个迁移场景。macOS arm64 与 Linux 随后在 R07 逐页取证时同样超时：期望 `2 / 6`，实际重新显示 `1 / 6`。取证程序在翻页过程中向受监控工作区写 PNG，引发文件列表刷新和预览重载；现先捕获全部六页，再创建目录、写文件和测量图片，并等待 Renderer 显示的 sourceId/generation 与二进制回执一致。

Windows 改为在受限目标内通过 `CreateProcessW` 与 `GetLastError()` 记录明确拒绝，只有 `ERROR_CHILD_PROCESS_BLOCKED=367` 和固定退出码才通过。探测程序由现有 PowerShell/C# 编译能力在限制之外构建成无控制台的 WindowsApplication；宿主以 `DETACHED_PROCESS` 启动受限目标，保留原来的禁止子进程策略、继承输出句柄和 Job 清理。此启动调整仍需下一轮原生 Windows 验证，不计作本地通过。

本轮本地复验：Runtime 75 项通过、4 项因主机/沙箱限制跳过；发布契约 44 项通过；PNG 测量与预览组件 3 项通过。新增真实 Electron 回归通过，证明六页捕获期间五次翻页均未创建输出目录，最终六张 PNG 的顺序、文件哈希和实际测量与样本一致。类型检查、完整 lint 和变更文件 lint 通过（全仓仍有既有格式警告），diff 检查通过。HTTPS 测试的清理只关闭实际监听的服务器，避免覆盖启动失败的原始错误。

旧运行最终以失败结束，macOS x64 最后完成的 R07 也出现相同的 `2 / 6` 与 `1 / 6` 不符。上述修复已提交并推送为 `2f2ea382dfdf29e36b400a4432112951e9c73b9d`。新四目标 `calibrate` 运行 [36379148451](https://github.com/Linnanli/dasWork/actions/runs/36379148451) 于 2026-09-28 04:46:56 UTC 创建，已确认 `headSha` 与修复提交一致、状态为 `in_progress`。按约定在此暂停，待用户告知运行完成后再读取产物、原生 Windows 对照与校准结果；完整计划仍未验收通过。

用户再次报告报错后确认该运行最终失败。Windows 的 `officecli-windows-child-probe-build` 在 30 秒超时且无输出，尚未进入受限/非受限对照；缺少工件导致 Windows P3 连带失败。三个非 Windows 原生构建与完整迁移通过，R07 仍在第二页显示 `1 / 6`。日志只能确认编译步骤超时，不能证明 PATH 是根因；现恢复限制之外编译器所需的宿主环境，规范 Windows PATH 大小写，并记录编译启动/读源/编译阶段，保留隔离临时目录、30 秒预算和目标执行白名单。

预览根因已由真实 React 组件重现：右侧面板 focus 引起父组件重绘，重新创建的 artifact descriptor、target 与 callback 使 `useArtifactSource` 加载 effect 重启，清空 binary 并卸载预览。修改前单元测试得到与 CI 相同的 `2 / 6`→`1 / 6`；前一轮 HTML 模拟回归仅证明延迟写入行为，未覆盖此真实组件问题。修复后同一来源的父重绘不再触发读取，实际文件更新仍重载、换路径重新授权，显式页码导航继续生效。新增 Electron 回归打包真实 `ArtifactTabContent`、`useArtifactSource` 和 `PresentationPanel`，验证六页顺序、哈希、像素指标及读取次数稳定。

独立审查确认同一项目的 workspaceId 可以跨会话保持不变，因此内部来源键同时绑定 conversationId/threadId；切换会话或线程须重新准备工作区和注册文件来源，不能复用此前的授权。新增两项真实组件回归覆盖该边界。

使用失败运行的真实 darwin-x64 归档进行本机完整桌面控制验证后，六页翻页已成功，随后真实像素检查发现议程样本只有一行正文，非白比例为 `0.007870732060185185`，低于原 `0.01` 门槛；其他五页均通过原指标。图片样本是放大的 1×1 黑图。现按原主题事实补齐议程并提供可读的控制流程输入图，继续保持原像素标准；总览图改为由六张实际 PNG 合成，并在检查前保留 PPTX、六页 PNG 和总览图作为失败附件。

完善样本后的控制验证还暴露取证时序问题：文件事件计时在打开预览前开始，首轮渲染未完成、尚未触发文件变化就达到 20 秒。现先等待预览就绪和来源 ID，再确认监听已安装后触发变化，仅接受对应 sourceId 的事件，并在结束时取消监听；原 20 秒事件等待预算保持。

六页实际 PNG、像素检查与总览图通过后，证据解析发现日志收集把包含两条消息的数据块当成一条 JSON，遗漏真实 loader 调用。已将测试宿主 stdout/stderr 各自缓冲并按完整行记录，保留 UTF-8 跨字节和退出前的末行；新增合并、拆分与双流回归。实际图片检查同时修正输入图纵横比和封面文字对比度，未改变渲染器或视觉门槛。

最终本机完整 R07 控制通过（1 项，约 2.2 分钟）：真实签名 Feed 安装、普通聊天、技能/loader、正常 app-server 命令生成、文件变化事件、六页预览、实际像素与证据链均通过。六页为 3840×2160；议程非白比例为 `0.17493055555555556`，图片页为 `0.02792799961419753`，六页颜色数量均大于 12。原始 [PNG 总览](officecli-runtime-migration/2026-09-28/darwin-x64-r07-control/r07-contact-sheet.png)、[逐页回执](officecli-runtime-migration/2026-09-28/darwin-x64-r07-control/r07-preview-render-receipt.json)、PPTX 与 app-server 记录已保存并核对图片哈希；[控制上下文](officecli-runtime-migration/2026-09-28/darwin-x64-r07-control/control-context.json) 绑定运行 `36379148451` 的真实归档、当前工作区文件哈希与实际验证范围。

本轮最终相关单元 4 文件、16 项通过，真实 Electron 交互回归 2 项通过；Runtime 77 项通过、4 项因主机/沙箱限制跳过，其中原生 Windows 2 项仍待 CI；Windows 相关本地测试为 11 项通过、2 项跳过。发布契约 44 项、桌面构建、Node/Web 类型检查、完整 lint、变更文件 lint 与 diff 检查通过。完整 lint 有既有格式警告。该本机控制使用确定性外部模型响应，仅复验 darwin-x64 功能，不是十样本性能校准、四平台验收或旧/新视觉比较；A1–A9 仍未全部接受。

修复提交 `4aedacd81e715ccbe4692e3088faa14d46c33f15` 已推送。新的四目标 `calibrate` 运行 [36387113375](https://github.com/Linnanli/dasWork/actions/runs/36387113375) 于 2026-09-28 06:34:04 UTC 创建，已确认 `headSha` 与该提交一致，状态为 `in_progress`。按约定在此暂停，待用户告知运行完成后再检查 Windows 原生正反对照、四平台真实 R07/迁移、图片与校准结果；未读取新运行的最终结果，完整计划尚未验收。

### 36387113375：字体与旧预览转换修复

用户报告报错后恢复检查，确认该运行最终失败。四目标原生构建、隔离输入验证与归档执行均通过，Windows 子进程正反对照也已进入通过的验证步骤；四目标完整 v2/v3 迁移矩阵全部通过。macOS 两目标的 P3 校准、真实 R07 和旧/新预览自动取证通过。Windows R07 通过，随后旧预览失败；Linux R07 在实际像素检查失败，不能据此接受完整四平台结果。

- Linux：保留的六页 PNG 显示中文为方框；摘要页实际非白比例为 `0.0026649305555555554`，低于原 `0.01`。Main 的 SVG 截图未载入 Runtime 自带字体，依赖宿主字体。现由健康 Runtime 的 `fonts` 路径读取 Noto Sans CJK SC，以数据字体放入隔离 SVG；Main 固定表达式在独立脚本环境等待字体及排版就绪，再截图。文档脚本、Node、外部请求仍禁用，字体路径不接受 Renderer 输入，原像素门槛和 Main 渲染预算保持。
- 字体等待控制：真实 Electron 证明在文档脚本禁用时，Main 普通脚本调用不能完成该等待，而固定隔离脚本可以；采用 [Electron 隔离脚本接口](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptinisolatedworldworldid-scripts-usergesture) 与 [FontFaceSet.ready](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/ready) 的字体/排版完成条件。真实截图中的中文已检查，不能用模拟 API 返回成功替代渲染证明。
- Windows：Main 明确报 `LibreOffice did not produce a PDF for presentation preview.`，不是单纯界面等待。旧 generic v2 的真实入口是 `soffice.com`。转换现使用历史 v2 技能验证过的 `pdf:impress_pdf_Export`，复用 `SAL_USE_VCLPLUGIN=svp` 与隔离 Windows profile/AppData 环境；无 PDF 时保留实际目录、stdout/stderr。未加入没有证据支持的 PDF 路径兜底；原生 Windows 是否恢复仍待下一运行验证。
- 旧版 Linux 预览也须加载 Runtime 字体：仅为旧转换进程提供隔离 fontconfig 和可写字体缓存，沿用历史 v2 原生验证的字体配置方式。
- 本机完整 R07 初次在 20 秒时仍显示“正在生成预览”，未出现 Main 转换错误。打开预览的等待现使用已有 120 秒 R07 预算，与 Main 的完整多页渲染预算一致；文件变化事件仍保持原 20 秒。

完整本机 R07 控制随后通过（1 项，约 3.3 分钟）：签名 Feed、普通聊天、实际 app-server 技能/loader/命令、文件事件、六页 PNG、哈希、真实像素与总览均通过。摘要页非白比例为 `0.018167558834876543`，六页均通过原像素标准。原始 [总览图](officecli-runtime-migration/2026-09-28/darwin-x64-r07-font-control/r07-contact-sheet.png)、[逐页回执](officecli-runtime-migration/2026-09-28/darwin-x64-r07-font-control/r07-preview-render-receipt.json)、PPTX/PNG 与 [控制上下文](officecli-runtime-migration/2026-09-28/darwin-x64-r07-font-control/control-context.json) 已保存并核对哈希。控制使用此前真实 darwin-x64 归档和确定性外部模型响应，证明本机字体及桌面链路；不替代 Windows/Linux 原生复跑、十样本预算、旧/新逐页视觉验收或最终门禁。完整 A1–A9 仍未全部接受。

相关单元 3 文件、15 项通过，发布契约 44 项通过；后者含真实 HTTPS 握手，需要允许本地回环端口。字体加载失败时不截图、字体加载完成前不截图、外部请求阻断、临时文件清理、旧转换 filter/环境/fontconfig 与错误输出有针对性回归。Windows 分支的独立复查未发现新实质缺陷，仍保留原生 CI 验证缺口。

最终桌面构建、Node/Web 类型检查通过；完整 lint 为 0 错误、539 条既有警告，所有变更 TypeScript 文件单独 lint 无输出，`git diff --check` 通过。工作流路径过滤已包含 Main 预览实现，后续预览代码变化会进入 Runtime 验证。当前验证不能替代新的四平台原生预览、校准审查与最终发布门禁。

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
