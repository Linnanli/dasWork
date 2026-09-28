# 用 OfficeCLI 替换项目 Office 能力的开发计划

日期：2026-09-27
模式：`$plan` direct；本文只规划，不修改产品代码。

## 实施与工程验收（2026-09-28）

主要迁移代码已落地，但复审发现验收缺口，完整计划尚未完成。已有四平台构建、安装压力测试、签名 Feed 与 Linux 打包版门禁记录：[36361322781](https://github.com/Linnanli/dasWork/actions/runs/36361322781)，提交：`316386121eb1747ca03328414279e34eae0008cc`。该运行的 R07 指标未读取真实 PNG，不能作为视觉验收完成的证据。

归档大小/哈希、四平台安装内存原始报告、预算审查、测试范围和发布边界见[迁移验收记录](../../docs/verification/officecli-runtime-migration.md)。最终 Feed 产物为工程验证用途；生产发布仍遵循既有发布门禁。

### 复审修复顺序

1. 先增加失败回归，修复激活事务边界：技能同步、reload 或旧插件退役失败时恢复旧 Runtime、受管技能及插件；恢复失败需完整报告，并覆盖崩溃恢复。
2. R07 验收改为逐页读取真实宿主 PNG、测量像素并绑定文件哈希；空白图、损坏图及证据不匹配必须阻断门禁。
3. 补齐既有 DOCX 表格/中文和 XLSX 公式/图表副本编辑保真，按固定版本实际支持的 JSON/非 JSON 命令契约检查结果。
4. 原生 OfficeCLI 子进程使用临时用户目录、受限环境及操作系统网络阻断，记录阻断探测结果；系统程序执行排除已接入 macOS 执行白名单、Linux execve/execveat 审计、Windows 启动时子进程限制。darwin-x64 的正反探测及 25 条真实 OfficeCLI 命令通过，其余原生平台待运行；不能只凭 PATH 声明 A2 通过。桌面 app-server 的运行环境保持其既有契约。
5. 四平台执行真实旧 v2→v3、冷启动、回滚及同步失败恢复矩阵，归档指针、技能、插件、能力快照与 reload 记录；旧/新预览逐页对比并记录视觉检查。
6. 先跑目标回归、类型和边界检查，再重新校准、审查预算并执行最终构建；按用户约定在触发 Runtime 打包后暂停等待运行结果。只有取得上述真实证据后才恢复“开发完成”声明。

修复提交 `432e0c6e2423151f83961a20c042da7240a67cc3` 的校准运行 [36373185725](https://github.com/Linnanli/dasWork/actions/runs/36373185725) 已失败：Windows 输入验证的进程隔离 helper 超时，macOS 两平台迁移 Feed 证书验证失败，Linux 迁移测试的 v2 能力断言错误被丢失内部错误列表后的 `map` 报错掩盖。继续修复，并补齐真实控制测试发现的冷启动旧 marketplace 查询范围；完整计划仍未验收通过。

## Requirements Summary

1. **目标**：以固定版本、经校验的 OfficeCLI 接管 `.docx`、`.xlsx`、`.pptx` 的本地创建、读取、修改和质量检查；保留现有 PPTX 工作区预览的对外结果与标注能力。当前 PPTX 生成链由 `presentation-skill`、PptxGenJS、Python、LibreOffice、Poppler 共同支撑，预览单独由 Main 调用 `soffice` 与 `pdftoppm`。依据：`primary-runtime/runtime-sources.lock.json:5-66,78-117`；`desktop-app/src/main/artifacts/PresentationArtifactPreviewService.ts:55-128`。
2. **归属**：OfficeCLI 是 Primary Runtime 内受控的宿主二进制；Main 负责发现、诊断、发布绝对路径及 PPTX 预览；模型通过现有 `load_workspace_dependencies` 获得路径并使用 app-server 正常命令执行。Renderer 只接收现有业务结果。依据：`desktop-app/src/main/appTools/desktopToolDefinitions.ts:85-125`；`docs/adr/2026-09-09-primary-runtime-reference-delivery.md:12-26`；`desktop-app/src/shared/artifactPreviewApi.ts:146-160`。
3. **退役**：新 Runtime 不再捆绑或宣传 `presentation-skill`，以项目自有的 OfficeCLI 技能说明取代；成功切换后停用旧 Runtime 插件并清理 Runtime 管理的旧技能。用户在其他位置自行安装的同名插件不属于本次清理范围。当前旧插件和技能在构建清单中被硬编码。依据：`primary-runtime/scripts/build-runtime.mjs:219-228,291-305`；`desktop-app/src/main/bundledPlugins/RuntimeOwnedSkillManager.ts:137-188`；`desktop-app/src/main/bundledPlugins/BundledPluginManager.ts:243-262`。
4. **产品范围**：维持现有工作区 PPTX 预览和标注；本次不新增 DOCX/XLSX 的内置图形编辑器。现有 Artifact 入口只接受 PPTX，Renderer 另用只读 OOXML 解析维持幻灯片对象信息。依据：`desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts:162-181`；`desktop-app/src/renderer/src/components/artifacts/presentation/presentationParser.ts:27-60`；`desktop-app/src/renderer/src/components/artifacts/ArtifactTabContent.tsx:102-152`。
5. **PDF 边界**：PDF 不是 OfficeCLI 替换目标。现有工作区依赖指令同时宣传 PDF，Poppler 也在 Runtime 清单内；只有确认 PDF 的独立能力路径后才能移除其组件或改写 PDF 指令。OfficeCLI 的 PDF 导出若依赖另装组件，须另行锁定和验收。依据：`desktop-app/src/main/developerInstructions/codexDesktopInstructionCatalog.ts:49-56`；`primary-runtime/runtime-sources.lock.json:106-117`。

## 方案与决策点

选择 **签名 Feed 中交付 OfficeCLI 原生二进制 + Runtime 自带独立技能**。沿用不可变版本目录、原子激活指针和 Main 的能力发布；不在 Renderer 直接调用 OfficeCLI，也不为 OfficeCLI 新建第二套模型或工具路由。当前交付架构见 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md:12-19,34-38`，独立技能机制见 `desktop-app/src/main/primaryRuntime/primaryRuntimeTypes.ts:49-63`。

先做四目标平台的**可行性门禁**：固定上游版本及各平台工件、证实可离线运行、证实截图/预览质量与必要依赖。2026-09-27 本机试验发现 OfficeCLI 1.0.152 的 `view screenshot --render html` 在无独立浏览器时返回 `no_screenshot_backend`；因此实现路径改为由 OfficeCLI 逐页输出 SVG，再用应用自带、隔离的 Electron Chromium 转成 PNG。该替代路径仍须通过四平台离线预览和 R07 视觉验收。若任何已支持平台无法获得可信、可再现的构建，或替代路径不能可靠产生逐页 PPTX 预览，不进入旧渲染链删除步骤。当前目标为 `darwin-x64`、`darwin-arm64`、`win32-x64`、`linux-x64`，见 `primary-runtime/scripts/source-lock.mjs:6-12`。

## Acceptance Criteria

| 编号 | 可验证的完成条件 | 证据位置/测试 |
| --- | --- | --- |
| A1 | 四个平台的 Runtime 均锁定 OfficeCLI 精确版本、来源、SHA-256、许可证；构建产物和来源回执可追溯；v3 归档通过 schema、归档、平台、解包及预算校验；无 `latest`、启动更新或运行时下载。 | `primary-runtime/runtime-sources.lock.json`、`primary-runtime/bundle-manifest.schema.json:5-28`、`primary-runtime/scripts/verify-runtime.mjs:142-160`；每目标构建及来源校验报告。当前锁结构见 `primary-runtime/scripts/source-lock.mjs:6-64`。 |
| A2 | 全新用户目录、断网且没有系统 OfficeCLI/LibreOffice/Python/Node 的干净环境中，四个平台的 Runtime 健康检查通过；DOCX、XLSX、PPTX 各完成读取、创建、修改副本、验证；原件 SHA-256 不变。 | `primary-runtime/scripts/verify-runtime-inputs.mjs`、每目标离线 smoke；现有检查高度绑定旧组件，见 `verify-runtime-inputs.mjs:40-63,497-580`。 |
| A3 | 新版 manifest 能声明 OfficeCLI 且不要求 Node/npm 包；Runtime 打包侧 v3 schema/验证器与桌面端 v3 解码器一致；旧 v1/v2 manifest 仍可解码以支持缓存、回滚和迁移；篡改、缺失、非可执行或越界路径均判为不可用。 | `primary-runtime/bundle-manifest.schema.json:5-28`、`primary-runtime/scripts/verify-runtime.mjs:142-160`、`desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts:59-93`、`PrimaryRuntimeDiagnostics.ts:96-138` 的单元与真实归档测试。 |
| A4 | `load_workspace_dependencies` 只发布当前健康 Runtime 中已核实的 OfficeCLI 绝对路径；Office 工作流不引用宿主 PATH、系统安装或旧 `node/nodeModules/soffice` 路径；非本地主机不可用。 | `desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts:1139-1163`、`workspaceDependencyInstructions.ts:5-36`、`desktopToolDefinitions.ts:85-125` 的测试。 |
| A5 | 新 Runtime 技能同步与 app-server 重新加载成功后，新 thread 可发现 OfficeCLI 技能/loader；旧 Runtime `presentation-skill` 已停用且其托管技能消失，包括 v3 已激活后应用首次启动的迁移场景。只能退役能证明由旧 Runtime 拥有的插件和技能，不触碰用户自行安装的同名项。同步失败时新能力不发布，旧可用版本保持或恢复；旧 thread 不被误认为热更新。 | `desktop-app/src/main/index.ts:273-305`、`BundledPluginManager.ts:100-160,243-262`、`RuntimeOwnedSkillManager.ts:137-188` 的故障注入及新旧 thread 集成测试。 |
| A6 | 原有 R07 六页 PPTX 生成与质量检查通过；OfficeCLI 逐页 SVG 的输出、统计 JSON 与失败/空页状态已固定为测试夹具，隔离的 Electron Chromium 离线转出 PNG；工作区预览仍返回页码连续的 PNG、正确 `sourceId/generation`，并保留对象标注所需的只读 OOXML 解析；超时、页数和输出大小限制仍生效。旧 v1/v2 Runtime 回滚期间的预览路径保留到兼容测试通过。 | `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:199-372,963-1033`、`PresentationArtifactPreviewService.ts:55-132`、`artifactPreviewApi.ts:146-160` 与 Renderer 测试。 |
| A7 | 新技能说明覆盖三种格式的创建/检查/修改副本/显式保存流程；命令执行结果同时检查进程退出码与 JSON 成败/告警状态，避免静默接受失败或覆盖原件。 | 新 Runtime-owned `officecli/SKILL.md`、`verify-runtime-inputs.mjs` 与端到端用例；现有技能发布位置见 `primaryRuntimeTypes.ts:53-63`。 |
| A8 | 新 Runtime 的生产清单、发布门禁和 UI 官方插件集合均不再引用旧 `presentation-skill`；旧 Runtime 的读取/回滚测试仍保留，不因清理生产路径被删除。 | `build-runtime.mjs:219-305`、`verify-app-tools-release-gates.mjs:289-307`、`write-app-tools-release-evidence.mjs:233-259`、`PluginCenterService.ts:255`、`pluginCenterDataResource.ts:703-706`。 |
| A9 | 全部相关单元、静态检查、签名 Feed 安装、离线 Runtime、打包烟测和真实 Renderer→Main→app-server→命令路径端到端测试通过；四目标均通过 Runtime 的 `verify`、`verify:platform`、`measure:unpack`、`verify:hard-limits`、`verify:budgets`；记录产物大小、单次冷启动耗时与峰值内存，超出当前预算时阻断发布。 | 验证命令见下节；预算文件 `primary-runtime/runtime-budgets.json`、`primary-runtime/runtime-hard-limits.json`；现有端到端路径见 `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:199-372`。 |

## Implementation Steps

### 1. 固定基线并做 OfficeCLI 可行性试验

- 用现有 R07 PPTX、含中文/表格的 DOCX、含公式/图表的 XLSX、已有文件修改样本建立测试语料和预期数据。记录旧预览的逐页 PNG、页数、质量检查结论与耗时；现有 R07 流程及逐页预览入口见 `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:199-372`、`PresentationArtifactPreviewService.ts:55-128`。
- 在四个干净目标环境调查并验证 **准确的 OfficeCLI 版本、工件格式、许可证、离线首次运行、自动更新关闭方式、逐页图像导出、字体要求、进程退出码与 JSON 状态**。验证 `create/read/edit/validate/view` 所需命令和显式保存语义；把实际命令和输出固定成 smoke 夹具，不能仅根据本机 `officecli` 成功判定跨平台可用。目标列表见 `primary-runtime/scripts/source-lock.mjs:6-12`。
- 决策门槛：若 OfficeCLI 对样本 PPTX 无法稳定产出与现有结果协议兼容的逐页预览，或四平台发布来源不可验证，暂停第 2～7 步的旧栈删除，产出差异与替代方案评审。

### 2. 重做 Runtime 供应链和版本清单

- 在 `primary-runtime/runtime-sources.lock.json`、`scripts/source-lock.mjs`、`scripts/runtime-inputs.mjs`、`scripts/materialize-runtime-inputs.mjs` 中增加 OfficeCLI 的按目标锁定、下载、哈希核对、可执行位/平台签名检查和归档路径规则；移除面向 `siril9/presentation-skill` 的固定候选、补丁和材料化流程。当前硬编码见 `source-lock.mjs:15-73`、`runtime-inputs.mjs:115-126`、`materialize-runtime-inputs.mjs:430-519`。
- `scripts/build-runtime.mjs` 生成 v3 manifest：`binaries` 含必需 `officecli`，旧 v1/v2 所需 Node 字段在 v3 可省略；项目自有技能写入 `bundledSkills`，旧插件不再写入 `bundledPlugins`，受管技能由新版本整体替换。保留独立 PDF 能力所需组件，依据实际消费者裁剪旧 Node/Python/LibreOffice/演示用依赖；现有 v2 构建见 `build-runtime.mjs:207-310`，旧源锁组件见 `runtime-sources.lock.json:78-117`。
- 同步改造 `primary-runtime/bundle-manifest.schema.json:5-28`、`scripts/verify-runtime.mjs:142-160`、`scripts/verify-runtime-platform.mjs:20-31`、`scripts/measure-runtime-unpack.mjs:17-25` 中的 v2/Node 固定假设，让 v3 归档从 schema 到平台解包检查使用同一契约；补充 v2 兼容与 v3 缺件/篡改归档测试。
- 同步更新 `primary-runtime/runtime-toolchains.lock.json`、预算/硬限制、来源回执、许可证清单和 `primary-runtime/README.md`；四目标归档、离线重建与 tamper 测试成为发布门禁。当前全目标及源锁约束见 `source-lock.mjs:6-64`。

### 3. Main 诊断、loader 与能力快照适配 v3

- 更新 `PrimaryRuntimeManifest.ts`、`primaryRuntimeTypes.ts`、`PrimaryRuntimeDiagnostics.ts`：v3 允许无 Node/npm 包，但必需 `officecli`；继续读取旧格式；诊断覆盖可执行性、根目录约束、清单哈希和技能文件。当前 Node 强依赖见 `PrimaryRuntimeManifest.ts:59-69`、`PrimaryRuntimeDiagnostics.ts:96-138`。
- 更新 `PrimaryRuntimeService.ts`、`workspaceDependencyInstructions.ts` 和 loader 结果类型：OfficeCLI 以 `binaries.officecli` 和明确的调用提示发布，不再虚构 `nodeModules`。`DesktopHostCapabilityRuntime` 与 `PrimaryRuntimeCapabilityPolicy` 按 Office 能力/技能同步状态表达就绪条件；旧 `presentationsEligible` 等字段可保留兼容别名，但不得误把 v3 的零 Runtime-owned plugin 判为不可用，并保持新 thread 的不可变快照行为。依据：`PrimaryRuntimeService.ts:1139-1163`、`workspaceDependencyInstructions.ts:5-36`、`PrimaryRuntimeCapabilityPolicy.ts:15-23,77-94`。
- 重新表述 `codexDesktopInstructionCatalog.ts:49-56` 的 Office 与 PDF 指令，使 PDF 不错误地随 OfficeCLI 可用性开启；保留 Main 动态工具和 preload 安全边界，依据 `desktopToolDefinitions.ts:85-125`。

### 4. 自有 OfficeCLI 技能与平滑退役

- 在 Runtime 输入中新增项目自有 `officecli/SKILL.md`：给出三种格式的发现、只处理工作区文件、先读后改、副本写入、显式保存、验证及预览步骤；禁止自更新、联网安装、系统 PATH 回退和模型密钥访问。对当前 `dascowork-primary-runtime/presentation-skill` 使用 `replaceManagedSkills()` 整体替换受管目录；**不通过 `skillsToRemove` 提前移走当前受管技能，也不把用户可能自行安装的根目录 `presentation-skill` 列为待删除项**。现有受管目录替换见 `RuntimeOwnedSkillManager.ts:137-188`。
- 修正 `desktop-app/src/main/index.ts:273-305`：同步就绪依据应是**期望的 Runtime 插件集合与技能集合均已正确协调**，允许新 Runtime 只有独立技能而无 Runtime-owned plugin；不能靠“至少一个 Runtime 插件”判断健康。
- 调整 `BundledPluginManager.ts:100-160` 的切换顺序：先确认新技能安装与 app-server reload，再退役旧插件；失败时恢复旧受管技能、旧插件及旧版本能力，加入故障注入测试。冷启动时也须从可信旧 Runtime 记录恢复待退役插件身份，不能仅依赖本进程先前的 descriptor。`skillsToRemove` 仅用于受管目录之外且可证明由本应用创建的历史路径；若确需使用，先在 `RuntimeOwnedSkillManager.ts:45-54,67-86` 中把新技能来源/哈希校验移到 legacy 移动之前，并给后续失败增加恢复测试。旧插件停用范围由 `retireOne()` 的 `sourceKind`/`internal` 条件限定，见 `BundledPluginManager.ts:243-262`。

### 5. 将 PPTX 预览改由 OfficeCLI 生成

- `desktop-app/src/main/artifacts/PresentationArtifactPreviewService.ts` 调用经诊断的 `officecli` 获取统计 JSON 和逐页 SVG，再由 Main 通过隔离的 Electron Chromium 转为 PNG；检查命令返回、SVG 尺寸、页码、PNG 文件大小、耗时和临时文件清理。对外保持 `artifactPresentationRenderResultSchema`，不修改 Renderer 的页码、generation 和 OOXML 标注逻辑。保留旧 v1/v2 归档的 `soffice`/`pdftoppm` 预览兼容路径，直到旧归档回滚测试通过。依据：`artifactPreviewApi.ts:146-160`、`ArtifactTabContent.tsx:102-152`。
- 把可行性试验得到的统计 JSON、逐页 SVG、空页和失败状态固化成 preview smoke 夹具；预览实现只按经过测试的契约解析。Electron 渲染器禁用 JavaScript、Node 与外部资源请求，并以真实打包 App 验证。当前 Result 要求连续页码，见 `desktop-app/src/renderer/src/components/artifacts/ArtifactTabContent.tsx:124-139`。
- 沿用现有进程隔离、超时与资源上限，补充恶意/损坏 PPTX、空预览、页数越限、输出过大、退出状态与 JSON 状态冲突的测试。当前 PDF 中转管线见 `PresentationArtifactPreviewService.ts:66-120`。

### 6. 更新烟测、端到端证据和产品文档

- 用三格式 OfficeCLI smoke 替代 `primary-runtime/scripts/verify-runtime-inputs.mjs:497-580` 的旧演示脚本；把 `desktop-app/package.json:64` 的 `smoke:presentation-skill-runtime` 更新为 `smoke:office-runtime`，调整 `desktop-app/scripts/run-presentations-runtime-smoke.mjs`、`desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:199-372,687-926`，测试真实 signed Feed、技能加载、loader、正常命令、生成/修改/验证和预览。
- 更新 `desktop-app/scripts/verify-app-tools-release-gates.mjs:289-307`、`write-app-tools-release-evidence.mjs:233-259` 的技能路径与证据结构；更新 `PluginCenterService.ts:255`、`pluginCenterDataResource.ts:703-706` 的旧 marketplace 列表和对应测试。
- 全库检索并同步修改生产路径上的 `presentation-skill`、`soffice`、`pdftoppm`、Node 包断言及夹具，特别是 `desktop-app/scripts/tests/verify-app-tools-release-gates.node-test.mjs:56-61`、`primary-runtime-feed-e2e.node-test.mjs:76`、`primary-runtime-calibration-feed-e2e.node-test.mjs:105-120`、`primary-runtime/tests/runtime-inputs.node-test.mjs:496-497` 和 `runtime-patch.node-test.mjs:15-23`；仅保留专用于旧 v1/v2 读取与回滚的 fixture。
- 更新 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md:21-26,41-50`、`docs/specs/primary-runtime-capability-generation.md`、`primary-runtime/README.md` 和用户文案。撤销“已有 PPTX 编辑不支持”描述，仅在 OfficeCLI 样本往返测试通过后宣传该能力；旧源锁的限制见 `primary-runtime/runtime-sources.lock.json:57-65`。

### 7. 灰度激活与回滚验证

- 用签名 Feed 发布 v3 候选，先在四目标工程环境安装和重复切换：v2→v3、v3 冷启动、v3→已保留 v2、断网、安装中断、技能 reload 失败、旧插件停用失败。验证普通聊天始终可用，新 thread 的 Office 能力只在健康且同步完成后出现。现有不可变目录/原子指针约束见 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md:12-19,34-38`；发布门禁入口见 `desktop-app/package.json:57-63`。
- 回滚以旧的已验证 Runtime 版本及其托管技能/插件状态为单位，记录激活前后清单、工具快照和 app-server reload 结果；不得只恢复指针而遗留新技能或已停用的旧插件。该风险来自当前退役位于技能同步之前的顺序，见 `BundledPluginManager.ts:124-160`。

## Risks and Mitigations

| 风险 | 缓解与停止条件 |
| --- | --- |
| OfficeCLI 在某平台缺少可校验工件，或首次运行需要下载/系统浏览器。 | 第 1 步在四目标离线环境证明工件及运行依赖；失败则不移除旧渲染链。目标与当前锁策略见 `primary-runtime/scripts/source-lock.mjs:6-64`。 |
| 新截图与旧 PPTX 预览、中文字体或对象标注不一致。 | 用 R07 和真实样本逐页比对、人工审阅；保留只读 OOXML 解析和 API 合约，预览验收失败则不发布。相关逻辑见 `PresentationArtifactPreviewService.ts:55-128`、`presentationParser.ts:27-60`。 |
| 上游更新、守护/驻留模式或不完整保存导致不可复现和数据损坏。 | 锁版本并关闭更新；使用临时副本、显式保存、重新打开验证、原件哈希检查；不得信任单一退出码。当前 Runtime 排斥运行时在线安装，见 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md:41-50`。 |
| 旧插件先停用，新技能后失败，造成空窗。 | 先完成新技能与 reload，再退役；故障注入和整体回滚覆盖，依据 `BundledPluginManager.ts:124-160`。 |
| 删除 Poppler/Node/Python 误伤 PDF 或旧缓存。 | PDF 独立列账，v1/v2 只读兼容，按实际消费者逐项移除；目前 PDF 指令与 Poppler 锁仍存在，见 `codexDesktopInstructionCatalog.ts:49-56`、`runtime-sources.lock.json:99-117`。 |
| 单文件解析或截图引起资源耗尽。 | 沿用 Main 的输入上限、超时、逐页/总输出限制；加损坏文件及大文件测试，见 `PresentationArtifactPreviewService.ts:55-132`。 |

## Verification Steps

1. **Runtime/源锁**：`npm --prefix primary-runtime test`；每个目标在材料化输入生成后运行 `npm --prefix primary-runtime run verify:inputs -- --target <目标> --input-root <该目标输入目录>`，再构建归档，依次运行 `verify`、`verify:platform`、`measure:unpack`、`verify:hard-limits`、`verify:budgets` 脚本（传入各脚本要求的目标、归档和回执路径），最后执行离线 OfficeCLI 三格式 smoke；核查来源回执、许可证、预算及运行时无下载。入口和必填参数见 `primary-runtime/package.json:9-23`、`primary-runtime/scripts/verify-runtime-inputs.mjs:746-781`、`primary-runtime/scripts/verify-runtime-platform.mjs:133-156`、`primary-runtime/scripts/measure-runtime-unpack.mjs:123-147`。
2. **桌面静态和单元**：`npm --prefix desktop-app run lint`、`npm --prefix desktop-app run typecheck`、`npm --prefix desktop-app test`；重点覆盖 manifest v1/v2/v3、诊断/loader、技能切换失败、预览失败与旧缓存回滚。入口见 `desktop-app/package.json:13-14,45`。
3. **架构与发布门禁**：`npm --prefix desktop-app run verify:codex-native-runtime-boundaries`、`npm --prefix desktop-app run verify:codex-app-server-protocol-contract`、`npm --prefix desktop-app run verify:bundled-plugins`、`npm --prefix desktop-app run verify:app-tools-release-gates`。入口见 `desktop-app/package.json:34-36,57-58`。
4. **安装与真实链路**：`npm --prefix desktop-app run test:primary-runtime-real`、`npm --prefix desktop-app run test:primary-runtime:stress`、`npm --prefix desktop-app run smoke:packaged-app-tools`、迁移后新增的 `npm --prefix desktop-app run smoke:office-runtime`、`npm --prefix desktop-app run test:e2e -- --reporter=line`。端到端至少证明 Renderer→IPC→Main→loader/技能→app-server 命令→文件验证→PPTX 预览；当前入口见 `desktop-app/package.json:20,60-64`、`desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:199-372`。

**GitHub Actions 暂停点**：本地验证及变更提交后，触发 `.github/workflows/primary-runtime-build.yml` 的四目标 `calibrate` 打包；记录 run URL/ID 并确认运行中，然后暂停执行，等待用户告知打包完成。收到完成消息后再检查四平台产物、预算及签名 Feed 证据，按工作流要求继续 `review`/`final` 阶段；不得把开始运行当作 A1–A9 已全部通过。

**停止条件**：A1–A9 全部满足，四目标离线证据与签名 Feed/回滚记录可复查，生产清单不再含旧 `presentation-skill`，且 PDF 能力未退化。计划完成不等于代码已实施。
