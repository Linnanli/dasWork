# OfficeCLI Runtime 迁移验收记录

日期：2026-09-29

计划：`.omx/plans/2026-09-27-officecli-office-capability-migration.md`

## 复审结论

**尚未完成全部计划验收。** 最新校准 [36420932977](https://github.com/Linnanli/dasWork/actions/runs/36420932977) 的四目标原生构建成功，但 Linux P3b 真实预览失败：表格文字和图表中文丢失。当前已修复字体契约和 Main 图像生成路径，本地真实 Linux 两轮及 macOS 六页均通过原门槛；A6/A9 仍等待新四目标校准、实图接受、预算审查与 final。

| 条件 | 当前状态 | 尚缺的证据 |
| --- | --- | --- |
| A1：固定版本与四平台供应链 | 本轮四平台来源、原生归档及来源回执已通过 | 新修复后的最终归档与工程 Feed |
| A2：干净、离线三格式验证 | 四平台网络/执行正反探测、各 25 条隔离命令已通过 | 最终构建继续绑定相同来源并复验 |
| A3：v3 清单及 v1/v2 兼容 | 四平台实际 v2/v3 归档与迁移已通过 | 最终构建复验 |
| A4：健康 Runtime 路径及能力发布 | 四平台失败恢复后保留健康旧 Runtime，快照与聊天已通过 | 新提交及最终门禁 |
| A5：技能、插件与 Runtime 整体切换 | 四平台各 12 个真实迁移场景通过 | 新提交及最终门禁 |
| A6：六页真实 PNG 预览 | 最新校准 Linux 缺字失败；修复后本地 Linux 两轮、macOS 六页通过，Linux 重跑逐页 SHA 相同 | 新四目标原生实图、重新逐页视觉审查与接受 |
| A7：三格式技能与命令结果检查 | 四平台复杂副本修改、保存、重新读取及 JSON/退出码检查通过 | 最终构建复验 |
| A8：生产路径退役旧插件 | v3 清单不含旧插件；四平台冷启动与受管技能/插件切换记录通过 | 最终构建复验 |
| A9：全部门禁及性能预算 | 上次完整候选预算已审查；本轮显式 Regular 改变源锁哈希，需重新校准 | 新四目标校准/预算审查、final 打包与签名工程 Feed 门禁 |

上一轮完整报告与图片见 [36412021750 证据](officecli-runtime-migration/2026-09-28/calibration-36412021750/README.md)。它们使用真实旧 v2 归档、签名 HTTPS Feed、真实 app-server 和逐页 PNG；通过自动取证不代表视觉质量已经接受。下方早期验证与失败记录按历史顺序保留，当前状态以上表为准。

离线 smoke 使用临时用户目录和受限环境，先验证网络连接正向对照成功且隔离后失败，再检查系统程序执行：macOS 仅允许 OfficeCLI 绝对路径执行；Linux 在网络隔离内以 strace 逐次核对 execve/execveat；Windows 在 CreateProcessW 启动时设置禁止创建子进程策略。正反探测必须实际执行，缺少工具或不完整记录均失败。本轮四平台的正反探测与各 25 条隔离命令已通过，并核对实际回执；最终归档继续复验这些约束。

早期本地验证记录：桌面针对性回归 7 个文件、94 项通过；Runtime 测试 72 项通过，Linux/Windows 原生探测 2 项因主机平台不同跳过；发布流程测试 43 项通过；架构及发布证据检查测试 23 项通过。静态类型检查通过，lint 为 0 个错误、540 项现有格式警告。本机真实隔离 smoke 的 25 条 OfficeCLI 命令通过，其中三格式 smoke 为 24 条；每条执行记录与命令、退出码逐一对应，网络隔离结果为 `EPERM`，原始记录见[darwin-x64 验证回执](officecli-runtime-migration/2026-09-28/darwin-x64-officecli-isolated-smoke.json)。当时尚未执行四平台真实迁移、旧/新预览对比和最终打包验收。

旧/新预览报告保留原始尺寸，并按相同尺寸计算逐页像素差异；允许不同像素密度造成的边缘取整，不允许幻灯片比例改变。报告明确标记 `visualAcceptance.status=pending`、`accepted=false`。取得四平台真实图片后，仍需逐页检查中文、布局、表格和图表，才能接受 A6。

## 36412021750：自动门禁通过，实图发现 Linux 图表缺字

用户报告完成后，确认四平台 native build 和 P3 均成功，Windows 全尺寸预览及 macOS 产物上传已恢复。预算提取也成功，独立只读审查确认样本、公式、来源及锁哈希一致，所有观测值在候选预算内。原始 [回执核对结果](officecli-runtime-migration/2026-09-28/calibration-36412021750/audit-summary.json) 绑定本次提交和运行，并核对四平台各 12 个迁移场景、各 25 条隔离命令及四份内存记录。

实际旧/新图片复查仍发现阻塞：Linux 第 5 页的新图表缺少中文分类与图例，整页颜色和非白比例仍过门槛。OfficeCLI SVG 中这些文字存在，但使用未带 inline `style` 的 `<text>`；Main 此前仅给 `[style]` 元素补 Runtime 中文字体。现固定隔离脚本同时处理 SVG `text/tspan`，读取其继承字体并追加 Noto，不改变字体优先级、页面脚本禁用、网络阻断、窗口尺寸或超时。

继承字体回归在修改前失败、修改后通过。本机真实 Electron 使用这次 Linux 失败运行的 PPTX 输出完整六页 3840×2160，图表 15 个 SVG 文字节点全部带 Runtime 字体回退，两个分类和图例可见。新增图片门禁使用实际失败/正常 PNG 对照，检查固定 R07 图表的三个文字区域，保留实测值，原整页像素门槛保持。该 Mac 控制不能替代原生 Linux 恢复证据；A6 仍未接受，修复后需要新 calibrate，再做预算审查与 final。

本轮本地验证：23 个相关单元、44 个发布契约、10 个预算/硬上限测试通过；完整桌面 build、Node/Web typecheck、原生运行时边界和 bundled plugins 检查通过；完整 lint 为 0 错误、539 个既有警告。发布契约首次被沙箱端口限制阻断，允许临时本地 HTTPS 服务后 44 项全量通过。独立只读审查未发现字体优先级、安全边界或门禁接入阻塞。[实测与 Mac 控制证据](officecli-runtime-migration/2026-09-28/calibration-36412021750/README.md) 明确保留原生 Linux 和最终工程 Feed 的验证缺口。

修复提交 `45a4e151b3e83c772f3ff58ae83756cde29377fd` 已推送。新四目标 `calibrate` 运行 [36420932977](https://github.com/Linnanli/dasWork/actions/runs/36420932977) 于 2026-09-28 12:17:53 UTC 创建，已确认绑定该提交并处于 `in_progress`。按约定暂停，待用户完成通知后再检查原生 Linux 图表文字、四平台实图、校准和后续预算/final 门禁；未读取新运行最终结果，A1–A9 仍未全部接受。

## 36420932977：真实 Linux 复现与图像生成路径修复

用户报告报错后，确认四目标原生构建与三个非 Linux P3 成功；Linux P3b 在原门槛 `colorBucketCount > 12` 失败，表格 PNG 实测为 12。实际 PPTX 与 SVG 的文字完整，问题在 Main 预览：表格截图早于文字绘制；图表的系统字体优先于 Runtime 字体，等待也不能恢复中文。直接运行旧 Main 的 Linux 控制已复现两者。

本轮改为私有 CJK face 与按字符范围的优先字体，保留 Latin 原字体；Runtime 源锁明确 Regular/400/normal，构建与输入验证按同一精确路径选择，缺失时失败。随后删除隐藏窗口截图和 offscreen 首帧完成条件，由隔离的 Chromium 完整解码 SVG 后绘制到白底 canvas 并导出 PNG，Main 继续校验空图及尺寸。没有修改 R07 原像素门槛、图表文字区域或输入样本。

最终真实 Linux 两轮和本机 macOS 各输出完整六页，全部通过原检查；Linux 六页两轮 SHA 逐页一致。表格颜色桶为 68，图表分类和图例可见；字体诊断确认中文 Regular 与 Latin 既有字体分别被选中。Linux 控制使用 Debian 13 与校验过 SHA 的 Electron 39.8.10、OfficeCLI 1.0.152；不能替代原生 Ubuntu/Windows/macOS 四目标新校准及完整签名 Feed 验收。[原始失败、修复实图、来源与逐页回执](officecli-runtime-migration/2026-09-29/calibration-36420932977/README.md) 已保存。

针对性桌面回归 27 项、Runtime 77 项（4 项平台跳过）、发布契约 44 项通过。独立只读审查确认直接 SVG 解码路径移除了已复现的窗口截图时序依赖，未发现本轮生产阻塞；完整桌面 build、Node/Web typecheck、原生运行时边界、bundled plugins 和 diff 检查通过。完整 lint 为 0 错误、539 条既有警告，变更 TypeScript 文件单独 lint 无输出。新原生 Runtime 清单和新源锁预算尚未接受，A1–A9 仍未全部完成。

## 校准失败与后续修复（历史）

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

修复提交 `c49c334253650c7fc650a2d1f7ca5e99dbb4ba38` 已推送。新四目标 `calibrate` 运行 [36395096696](https://github.com/Linnanli/dasWork/actions/runs/36395096696) 于 2026-09-28 08:03:26 UTC 创建，已确认 `headSha` 绑定该提交、状态为 `in_progress`。按约定在此暂停，等待用户告知完成后再检查 Windows 旧预览转换、Linux 中文实图、四平台原生预览与校准证据，并继续必要的 `review`/`final` 门禁。未读取新运行的最终结果，完整计划尚未验收。

### 36395096696：首帧、字体后备与旧迁移短目录

用户报告运行完成且有报错后恢复检查，确认该提交的运行最终失败。四目标原生构建/归档执行、四目标完整 v2/v3 迁移矩阵均通过；macOS 两目标 P3、旧/新 PNG 自动取证和校准通过。Windows 新 R07 通过，旧预览未产出 PDF；Linux R07 在实际 PNG 检查失败。

- Linux 原始 PNG：封面为 1920×1080 单色背景，颜色数量为 1；另外五页有内容但中文仍显示为方框。失败 [原始诊断产物](https://github.com/Linnanli/dasWork/actions/runs/36395096696/artifacts/10958804581) 已读取，不能将上轮加载字体的本机控制当成 Linux 验收。
- Main 原先在 `loadFile` 和字体布局返回后立即截图，没有等隐藏窗口首帧和后续绘制。现先注册并等待 [Electron 首帧事件](https://www.electronjs.org/docs/latest/api/browser-window#using-ready-to-show-event)，为已有字体样式追加 Runtime 中文后备字体（OfficeCLI 的部分 `Aptos` 样式没有中文后备），再等待字体布局和两个动画帧后截图。仅固定 Main 表达式执行；文档脚本、Node、外部请求和原资源/像素限制保持。
- 实际 Electron 独立控制通过：把测试 SVG 的首选字体改为不存在的名字后，Chromium 的实际字形报告仍确认标题和正文使用 `NotoSansCJKsc-Regular` 数据字体，分别为 16 个字形、`isCustomFont: true`；实际中文 PNG 已检查。该控制证明本机字体使用与首帧等待，不是 Linux 原生执行证明。
- Windows 新诊断：旧转换 stderr 为 `Could not find platform independent libraries <prefix>`，输出目录为空。实际 retained v2 根是系统 `C:\Users\runneradmin\AppData\Local\Temp\primary-runtime-migration-...\cache\versions\<sha256>`，而已下载归档在短根 `D:\a\_temp`。迁移测试现与桌面 E2E 一致优先用 `RUNNER_TEMP`、缩短前缀为 `dsc-mig-`，保留/清理/真实根回执逻辑保持。短根是当前证据支持的候选，不能在原生复跑前宣布解决。
- 旧转换失败诊断补充 `soffice` 路径长度、最多两个内置 `python-core-*` 中 `lib/os.py` 的真实存在状态及路径长度，便于原生运行区分安装路径与缺件；不输出整个宿主环境，不加入没有存在证据的 Python 变量清理。

相关单元 3 文件、18 项通过，新增首帧等待、实际执行固定字体/动画帧表达式的回归以及旧 Python 文件诊断回归；发布契约 44 项通过。Windows 独立只读复查未发现迁移 retained cache、清理或报告链路的实质破坏。新四目标预览、校准审查、旧/新人工视觉验收及最终门禁仍待完成，A1–A9 尚未全部接受。

完整本机 R07 控制通过（1 项，约 3.1 分钟）：真实签名 Feed、聊天、app-server 技能/loader/命令、文件事件和六页 PNG 均通过。六页为 3840×2160，摘要非白比例为 `0.018167558834876543`，原像素门槛保持；PPTX 与六页哈希逐项核对，实际中文总览已检查。证据保存在 [PNG 总览](officecli-runtime-migration/2026-09-28/darwin-x64-r07-frame-control/r07-contact-sheet.png)、[预览回执](officecli-runtime-migration/2026-09-28/darwin-x64-r07-frame-control/r07-preview-render-receipt.json)、[字体字形报告](officecli-runtime-migration/2026-09-28/darwin-x64-r07-frame-control/font-platform-glyphs.json) 和 [控制上下文](officecli-runtime-migration/2026-09-28/darwin-x64-r07-frame-control/control-context.json)。控制绑定此前真实 darwin-x64 归档和本次工作区文件哈希，使用确定性外部模型响应；不将它当作 Windows/Linux 原生执行、十样本性能校准或旧/新人工视觉验收。

最终桌面构建、Node/Web 类型检查通过；完整 lint 为 0 错误、539 条既有警告，变更文件单独 lint 无输出，`git diff --check` 通过。

另从锁定的 v2 原始 [Windows 构建工件](https://github.com/Linnanli/dasWork/actions/runs/35977341257/artifacts/10798893686) 按绝对字节范围读取小型原生验证、清单和来源回执，核对 ZIP CRC、清单 SHA-256 与锁定归档身份。历史验证回执证明该归档完成四页真实转换；它的原生 Runtime 根短于本轮 retained 根的 152 字符。原始文件和实际根比较保存在 [v2 控制上下文](officecli-runtime-migration/2026-09-28/win32-x64-v2-baseline/source-context.json)。嵌套归档本身被压缩，未在本机完整重下或逐项读取内置 Python 文件；此处不宣称已证明 Python 缺件或长路径是唯一根因，下一轮 Windows 原生结果仍是必要证据。

修复提交 `aa27d8fdf5b3f2a0722c075efa4b48c44df7d1ed` 已推送。新四目标 `calibrate` 运行 [36403623699](https://github.com/Linnanli/dasWork/actions/runs/36403623699) 于 2026-09-28 09:27:34 UTC 创建，已确认 `headSha` 与该提交一致、状态为 `in_progress`。按约定暂停，待用户完成通知后再读取 Windows 旧转换、Linux 首帧/中文实图、四平台校准以及必要的 `review`/`final` 结果；尚未读取新运行最终结果，完整计划仍未验收。

### 36403623699：Windows 小桌面裁切与 macOS 产物上传超时

用户通知完成且有错误后，读取绑定提交的真实任务结果：四目标原生构建/归档执行、四目标 v2/v3 迁移矩阵通过。Linux 和 macOS ARM 的 P3、六页旧/新取证与十样本校准通过；macOS Intel 的全部验证与校准通过，失败发生在上传产物 `CreateArtifact` 请求，错误为 `ETIMEDOUT`，不是预览或测量失败。

Windows 旧转换已成功产出六页 `1921×1080` PNG，说明短迁移目录下旧转换恢复；不把这扩展为所有安装路径均已验证。Windows 新预览六页原始 PNG 都是 `1008×681`，含滚动条，宽高比偏差 `0.18372370016848974` 超过原单像素舍入容差 `0.003906980406377288`。此处是实际裁切，保留原比较门槛。

Main 现等隐藏首帧后调用 [setContentSize](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentsizewidth-height-animate) 恢复 SVG 声明的内容区尺寸，再加载字体并等两个动画帧。启用 [enableLargerThanScreen](https://www.electronjs.org/docs/latest/api/structures/browser-window-options#enablelargerthanscreen-boolean-optional-macos) 覆盖 macOS 的大窗口限制；该选项只对 macOS 相关，Windows 修复依赖显式内容区尺寸设置。返回 PNG 前检查实际截图最低分辨率和宽高比，允许 `3840×2160` 高分屏输出与一个像素的边缘舍入，拒绝 `1008×681` 裁切图。文档脚本、Node、外部请求和原资源限制保持。

真实 Electron 控制使用本次实际 Windows PPTX 的六页 SVG，测试插件只将初始隐藏窗口强制缩为 `1008×681`。六页修复后 `innerWidth/innerHeight` 和 `scrollWidth/scrollHeight` 均为 `1920×1080`，PNG 均为 `3840×2160`；逐项核对原失败 PNG、源 PPTX 与控制 PNG 哈希，并检查中文总览。单独启用 offscreen 的控制仍被裁切，因此未采用它作为修复。原始失败图、原转换旧图、实际失败日志、控制 SVG、六页完整 PNG、视口回执及控制来源保存在 [控制上下文](officecli-runtime-migration/2026-09-28/preview-viewport-control/source-context.json) 和 [修复后的六页总览](officecli-runtime-migration/2026-09-28/preview-viewport-control/local-initial-small-window/contact-sheet.png)。此为本机小窗口控制，不能替代 Windows 原生执行或旧/新人工视觉验收。

相关单元 23 项通过，回归覆盖尺寸修正顺序、裁切拒绝、高分屏和单像素舍入；发布契约 44 项通过，桌面构建和 Node/Web 类型检查通过。完整 lint 为 0 错误、539 条既有警告，变更文件 lint 无输出。独立只读复查未发现安全、时序或正确性阻塞；Windows 窗口管理器实际行为仍须新 CI 确认。macOS 的产物上传网络错误在新运行重试；完整四平台校准、审查及最终门禁仍待完成，A1–A9 未全部接受。

完整本机 R07 再次通过（1 项，约 3.8 分钟），覆盖真实签名 Feed 安装、普通聊天、app-server 技能/loader/命令、文件事件及宿主预览。六页 PNG 为 `3840×2160`，原非白比例/颜色门槛通过，逐项核对 PPTX 与 PNG 哈希并检查中文总览。证据包含 [本轮 R07 回执](officecli-runtime-migration/2026-09-28/preview-viewport-control/local-r07/r07-preview-render-receipt.json)、[实际六页总览](officecli-runtime-migration/2026-09-28/preview-viewport-control/local-r07/r07-contact-sheet.png) 和控制上下文中的本次工作区文件哈希及不可变归档身份。该单次功能控制使用确定性外部模型响应，不能替代 Windows/Linux 原生执行、十样本校准、旧/新人工视觉验收或最终门禁。

修复提交 `84732005a79c559c2111b1764efc0a13d0ca2cc8` 已推送到规范仓库地址，首次推送 HTTP 400 后重试成功。新四目标 `calibrate` 运行 [36412021750](https://github.com/Linnanli/dasWork/actions/runs/36412021750) 于 2026-09-28 10:49:59 UTC 创建，已确认 `headSha` 与该提交一致、状态为 `in_progress`。按约定暂停，待用户完成通知后再检查 Windows 六页完整尺寸、macOS 产物上传、四平台校准及必要的 `review`/`final` 结果；尚未读取新运行最终结果，完整计划仍未验收。

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
