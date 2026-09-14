# Primary Runtime 参考架构复刻与授权 PPT 插件替换计划

日期：2026-09-12

模式：`$plan` direct / reference review

状态：计划已按 `reference-projects/codex-electron-26.818.21641-beautified` 重新校准，并将完成线收敛为仓库和 GitHub Actions 可以直接实现、自动验证的工程闭环。唯一有意偏离参考项目的产品能力，是使用经过授权和来源审计的 Codex PPT plugin 取代 OpenAI Presentations plugin 与 `@oai/artifact-tool`。Primary Runtime 的配置解析、下载、更新、staging 安装、依赖加载、plugin 同步和执行方式以参考项目为标准；参考包没有公开 Runtime 制品生产端，因此“源码/工具链锁定 → GitHub Actions 四目标原生物化 → native load/render 验证 → P1a 禁发候选 → P3a installer → P3b 实测与预算审查 → final staging → GitHub artifact 形式的工程 feed”是本项目新增的工程契约，不冒充参考项目事实。Apple Developer ID/notarization、Windows Authenticode、生产 feed 私钥、平台/发布信任回执以及公开 origin/CDN 提升已从本计划的门禁、Acceptance Criteria 和 Stop Condition 中移除；它们属于未来生产运营计划，不阻塞本计划达到 `engineering_complete`。本文是该工作的唯一执行真相源；`.omx/plans/primary-runtime-synthetic-feed-execution-plan.md` 只保留为历史测试说明。

## 1. 决策与范围

### 1.1 最终决策

1. 以 Runtime-owned 的 `siril9/presentation-skill` 作为授权评估候选，替代新建 PPTX 链路中的 OpenAI Presentations plugin 和 `@oai/artifact-tool`。P0 必须先把确切 tag、完整 commit、source archive SHA256、本项目 patch SHA256 和全部传递依赖许可证写入 source lock；在这些字段仍为空、使用 floating ref 或授权审计未通过时，状态保持 `外部证据阻塞`，P1a 不得开始。执行 AI 不得自行猜版本、跟随默认分支或静默换用其他 plugin。
2. 本轮产品能力只承诺三项：“新建 PPTX + 自动 QA + 工作区预览”。输入可以是工作区内的 HTML、文本、数据和图片，但不能是一个待修改的既有 PPTX；输出必须是本轮新生成的 `.pptx`、QA receipt 和可预览 artifact。
3. 除 plugin 内容与其依赖清单外，Primary Runtime 必须复刻参考项目的可观察行为：外部 runtime config、按平台/架构解析 release、启动/定时更新、staging 安装、校验后切换、安装后同步 bundled plugin/skill、`load_workspace_dependencies` 返回路径说明、模型再通过普通命令执行。
4. 不新增 `run_presentation_engine` 一类 Main-owned 宿主工具，也不把 Runtime 包装成第二套执行服务。若上游需要兼容 shim，该 shim 是 Runtime 内普通脚本或 Node package，由模型按 loader 返回的解释器/模块路径通过 app-server 的正常命令执行链调用。
5. 不修改 `codex/codex-rs/app-server/**`，不新增桌面侧 LLM client，不允许 Primary Runtime/plugin 直接读取模型 API key 或请求模型 HTTP API。
6. 四目标 runner 由 GitHub Actions matrix 实现并使用明确的原生镜像：`darwin-x64 → macos-15-intel`、`darwin-arm64 → macos-15`、`win32-x64 → windows-2025`、`linux-x64 → ubuntu-24.04`。runner 预装的 Node 只可用于启动仓库构建脚本，不能冒充被打入 Runtime 的锁定 Node/CPython/native/font 输入。
7. 本轮的发布物是 GitHub Actions artifact：四个 target staging、四目标汇总 receipt 和一个 production-shaped engineering feed repository。协调 job 只在四个原生 job 全部成功后组装这些 artifact，不写公开服务，也不更新任何生产 channel 指针。
8. 为覆盖客户端的 metadata 验签、篡改拒绝和 sequence 逻辑，CI 可在临时目录生成仅限本次 run 的测试密钥并签署 engineering metadata；私钥不得进入 artifact、缓存或日志。该结果只能标记为 `engineering/test-signed`，不能称为真实平台签名、生产可信 metadata 或信任回执。

### 1.2 完成定义

从 clean checkout 开始，GitHub Actions 四个原生 runner 能根据不可变 source/toolchain lock 自动获取并物化 Runtime 输入，生成 P1a 禁发候选；P3a installer 完成后，P3b 在同类 clean runner 上取得冷安装/event-loop 证据并提交可审查预算，随后重新构建四个 final target staging。协调 job 自动生成仅用于工程验证的 config/manifest、组装 production-shaped 静态 feed，并把四目标制品、receipts 和 feed repository 上传为 GitHub artifacts。随后从空 Runtime 缓存启动桌面应用，Main 能从本地/CI engineering feed 找到当前目标 archive，下载、显示进度、校验 SHA、拒绝越界 archive、在 staging 中诊断并激活；再同步 Runtime 内置的 PPT plugin/skill 并刷新 app-server skill catalog。模型先调用 `load_workspace_dependencies`，再使用其返回的 Node、Node modules、Python 和 binary paths 走普通命令链新建 PPTX，最终产物通过结构、渲染、溢出 QA 和工作区预览验收。

以下均不算完成：手工创建 `runtime-inputs/<target>`、使用 runner/开发机全局工具链作为 Runtime 内容、由人工拼装来源不明的 metadata artifact、用户全局安装 plugin、运行时 `npm install`/`pip install`、环境变量直指本机 Runtime、假 app-server/假 registry、预生成 PPT、只通过组件 smoke，或新增一个绕过 app-server 命令链的 PPT 专用宿主执行工具。没有 Apple/Windows 生产签名、生产信任回执或公开 CDN receipt 不再属于本计划未完成；但任何 CI artifact 都不得因此被标记为 `production_ready`。

### 1.3 本轮明确排除

1. 不承诺读取、修改或回写任何既有 PPTX；文本替换、图片替换、形状/图表/备注/元数据修改、页面增删或重排、主题/母版变更以及 round-trip 保真都不在本轮验收中。
2. 即使选定 plugin 自身具备部分编辑能力，本轮也不发布对应产品承诺、不为其增加 UI/API，并且不能用编辑既有 PPTX 的测试替代“从非 PPTX 工作区输入新建 PPTX”的证据。
3. “PPTX 可被 PowerPoint/LibreOffice 打开”是文件有效性 QA，不等同于本产品承诺编辑能力。若以后需要编辑既有 PPTX，另立 capability/parity 计划和独立 acceptance criteria。
4. Apple Developer ID 签名/notarization、Windows Authenticode、证书信誉和操作系统发布者信任不在本轮范围；本轮不引入 macOS 或 Windows 的输入签名步骤，原生执行/渲染验证是唯一所需的运行证据，所有 receipt 必须保留 `productionTrust=false`。
5. 生产 config/manifest 私钥托管、密钥轮换、受保护环境审批、正式 attestation 和第三方信任回执不在本轮范围。CI 临时测试密钥只用于证明协议代码有效。
6. 写入公开 origin/CDN、canonical production config 提升、生产缓存策略、公开后 forward-recovery 和真实用户流量验证不在本轮范围；GitHub artifact 不是公开 CDN，也不能作为已上线声明。
7. 如果未来要求最低 Windows 客户端版本、macOS Gatekeeper、SmartScreen 或真实 CDN SLA 证据，应另立 Production Readiness 计划并接入 self-hosted/专用 runner 与生产凭据，不能反向修改本计划的工程完成证据。

### 1.4 本轮可直接实现的工程交付

| 工程面 | 直接实现内容 | 自动完成证据 |
| --- | --- | --- |
| 输入供应链 | 锁定 Node、CPython、native binaries/modules、npm/Python 闭包、LibreOffice/Poppler、字体、plugin 与 patch；实现 fetch/materialize/verify | source/toolchain/input manifest、SHA、SBOM、notices、negative tests |
| 四平台构建 | GitHub Actions 四目标原生 matrix，删除本机 `--matrix` 伪四平台路径 | 四个固定名 target staging + runner/commit/lock 绑定 receipt |
| 平台执行验证 | 解压 archive，执行 Node/Python/native load、LibreOffice/Poppler 和字体 render | 每目标 `platform-validation.json`；明确 `productionTrust=false` |
| Runtime 消费链 | config/target 解析、下载进度、SHA/entry 检查、staging diagnostics、active 切换、更新/repair/cancel | unit/integration + 空缓存 feed E2E；失败保持旧 active |
| Plugin/loader/命令链 | marketplace/skill reconcile、force reload、参考式 loader text、app-server 普通 command | loader item → command item → PPTX/QA/preview 有序证据 |
| 资源预算 | P1a build/unpack、P3b cold install/event-loop 测量、独立 budget diff 与 final rebuild | 四目标 measurement、budget verifier、超限 fail-closed |
| 工程 feed | 同一 run 自动生成 test-signed metadata、组装 production-shaped 静态目录并上传 GitHub artifact | metadata 正负向测试、四目标汇总、无私钥扫描、`publiclyDeployable=false` |
| PPT 验收 | deterministic dev/packaged R07 新建六类页面并做结构/视觉/打开/预览 QA | PPTX、render/contact sheet、QA receipt、artifact source ID |

这些交付都能通过仓库代码、测试和 GitHub Actions 完成。真实签名、生产信任和公开发布没有等价的代码替身；本计划选择明确排除，而不是用 mock receipt 冒充。

## 2. 参考项目证据与本次定案

### 2.1 证据完整性

已运行完整索引校验：7188/7188 文件和 200 个位置记录一致。该参考包为 `beautified-fallback`，因此只能引用 readable file 的精确行号和 SHA，没有独立 raw 原包行列。

- `main-Cwjv9Ibf.js` SHA256：`f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e0bef4556264a515f70ef3a`
- `src-PzwkD6WC.js` SHA256：`63a92f6c811355a447bb65029b4963f7552ed31607de88858e494da1c995a4f5`
- `app-initial-DOX-K1rC.js` SHA256：`3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4`

### 2.2 问题 2：Runtime 如何执行 PPT——按参考项目定案

参考项目把 `load_workspace_dependencies` 定义为一个无参数、只读的宿主工具，作用是定位 Node、Python 和文档类工具依赖，见 [`app-initial-DOX-K1rC.js:171349`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:171349>)。它只在本地 host 且 app-server 的 `workspace_dependencies` experimental feature 启用时进入工具目录，见 [`app-initial-DOX-K1rC.js:457250`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:457250>) 和 [`main-Cwjv9Ibf.js:95578`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:95578>)。

调用时，Main 校验 local host/空参数/feature，调用 Primary Runtime service；安装成功后返回一段 instruction text，未安装则返回普通工具失败，见 [`app-initial-DOX-K1rC.js:457478`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js:457478>)。instruction text 包含 bundle version、Node executable、Node modules、Python executable、Python packages、override/fallback binaries，以及可选 Git/pnpm，见 [`src-PzwkD6WC.js:31476`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31476>)。

据此，本项目定案为：

- loader 负责返回已验证的依赖路径说明，不负责执行 PPT，也不返回任意命令执行能力。
- 模型按 plugin 的 `SKILL.md` 和 loader 输出，通过 app-server 正常的命令审批/执行链调用 Runtime Node/Python/QA 脚本。
- model-visible 输出只允许包含参考项目同类的绝对路径：Node executable、Node modules、Python executable、Python packages、override/fallback binaries，以及可选 Git/pnpm；不返回额外的顶层 Runtime `root`、任意 adapter 路径、archive/cache/feed 路径、内部 package inventory 或 Main 私有状态对象。
- 这些白名单绝对路径会被模型和 app-server 命令层看到，也可能作为工具结果进入会话 journal；这是按参考项目执行普通命令所需的明确边界，不应被误写成“所有 Runtime 路径都对 Renderer 保密”。Renderer 不获得新的通用文件系统 API，诊断日志和 release evidence 必须把 userData/Runtime 前缀归一化为 `<PRIMARY_RUNTIME>`，且不得记录下载 URL query、认证 header 或其他 secret。
- loader 输出不授予额外权限。后续命令仍受 thread cwd、sandbox、审批和 app-server command policy 约束；plugin 必须使用其 `SKILL.md` 中的固定调用模板与 loader 白名单字段，不能让模型拼接任意 adapter/脚本入口。
- missing/broken 时返回稳定、可读的工具失败；详细下载阶段、错误码和恢复操作放在 Main-owned UI/status API，不塞进 loader JSON。
- 当前实现把 loader 在 Runtime 未就绪时也发布并返回自定义结构化 JSON，见 [`desktopToolDefinitions.ts:70`](../../desktop-app/src/main/appTools/desktopToolDefinitions.ts:70)；这应改成“local + product/app-server feature gate”与参考文本结果，而不是继续扩展自定义协议。

### 2.3 问题 3：旧 v2 如何兼容——按参考项目定案

参考项目把 `bundleFormatVersion` 当作磁盘布局版本，而不是某个 PPT 引擎的代际；读取时对 format 1 和 `>=2` 使用不同的 Node/Python 根目录，且 `artifactToolVersion` 是可选 metadata，见 [`src-PzwkD6WC.js:31308`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31308>) 和 [`src-PzwkD6WC.js:32214`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:32214>)。客户端用 desired bundle version 与当前 metadata 比较，得到 `missing | current | outdated`，见 [`src-PzwkD6WC.js:31586`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31586>)。

非 MSIX 更新先下载到 staging、校验 SHA、检查 archive entry、解压并诊断 candidate；激活时暂时把当前目录改名为 `.previous`，新目录切换并再次诊断。新目录切换失败才恢复 `.previous`；成功后删除临时 previous，见 [`src-PzwkD6WC.js:31829`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31829>)。`resetDependencies` 是 force reinstall，不是长期维护多个可回滚 schema，见 [`main-Cwjv9Ibf.js:96401`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96401>)。

据此，本项目定案为：

- 不为 plugin 替换发明新的“引擎代际格式”。继续使用 format v2 的 `dependencies/node`、`dependencies/python` 和 `dependencies/native` 布局。
- 把当前 v2 parser 从“必须存在 `artifactToolVersion` 并合成 `@oai/artifact-tool`”改为通用 v2 manifest；同时保留一个 legacy-v2 读取分支，只用于识别、诊断和升级已有旧缓存。当前硬编码位置见 [`PrimaryRuntimeManifest.ts:68`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts:68)。
- 新 feed 只发布通用 v2 manifest，不再发布 `artifactToolVersion` 或旧 package 路径；版本是否需要升级由 `bundleVersion` 决定。
- 兼容目标是“旧缓存可识别、可被新版本安全替换”，不是“成功升级后仍长期保留旧 v2 引擎供用户一键回滚”。
- legacy-v2 decoder、diagnostics 和 Runtime-owned legacy plugin desired-set 只读保留，用于让升级前的旧 active 可诊断且在升级失败时继续工作；它们不得再构建/发布旧 release，也不得把 legacy plugin 安装到通用 v2。通用 v2 激活成功后，只清理 Runtime-owned legacy descriptor/skill，绝不删除用户安装的 plugin。
- 现有 immutable version directory + active pointer 可以保留为内部实现，只要契约测试证明与参考项目同样的可观察语义：candidate 诊断完成前 active 不变，提交失败 active 不变，成功后只有新 active 对后续调用可见。不得再增加跨 plugin/pointer/capability 的自定义 generation 协议作为参考复刻的前置条件。
- 必须有两条显式迁移测试：`legacy-v2 active → 通用 v2 candidate 失败 → legacy-v2 仍为 active 且可诊断`，以及 `legacy-v2 active → 通用 v2 成功 → 新 active 生效且 legacy desired-set 退出`。本计划不创建 v3，因此不使用“v2 → v3 → v2”作为兼容模型。

### 2.4 问题 4：包体大小怎么定——按参考项目定案

参考配置允许目标 archive 声明可选 `size`/`archiveSizeBytes`，见 [`src-PzwkD6WC.js:18859`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:18859>) 和 [`src-PzwkD6WC.js:18883`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:18883>)，但下载主链并没有参考数值上限；实际下载从 HTTP `Content-Length` 取得可选 total bytes，每约 500ms 汇报进度并流式写盘，随后计算 SHA-256，见 [`src-PzwkD6WC.js:32041`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:32041>)。archive entry 在解压前检查不能逃出目标目录，见 [`src-PzwkD6WC.js:31610`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31610>)；磁盘写满按 `disk_full` 归类，见 [`src-PzwkD6WC.js:31357`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31357>)。

据此，本项目定案为：

- 不需要用户现在拍一个压缩包最大值、解压倍率或固定预留空间数字；这些不是参考项目的架构参数。发布前仍必须建立本项目自己的可失败资源预算门禁，不能只把测量值记录在报告里。
- archive 必须按目标平台/架构分包，只下载当前目标，不把四平台二进制塞进同一个 archive。
- `Content-Length`/manifest size 用于进度和发布证据；缺失时下载仍可继续，完整性以 SHA-256 和 candidate diagnostics 为准。
- 保留流式写盘、取消、SHA、越界 entry 防护、staging cleanup 和 `ENOSPC → disk_full`。当前 `2 GiB archive / 8 GiB unpacked / 2 GiB headroom` 是本项目已有防御常量，不再被写成“参考项目标准”或产品验收值，见 [`PrimaryRuntimeInstaller.ts:52`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts:52)。若保留，应只作为高于实际发布物基线的防滥用上限，并由实包报告校准。
- 新增受版本控制的 `primary-runtime/runtime-hard-limits.json` 与 `primary-runtime/runtime-budgets.json`。前者只允许 P1a 构建禁发候选并提供不可自动放宽的防滥用边界；后者在 P3a installer 完成后，由 P3b clean-runner 测量和独立审查产生。每个发布目标必须提交正整数 `maxArchiveBytes`、`maxUnpackedBytes`、`minimumFreeDiskBytes`、`maxColdInstallMs`、`maxMainEventLoopDelayP99Ms` 和 `maxMainEventLoopDelayMaxMs`；文件缺失、目标缺失、非数值、release budget 高于 hard limit 或任一实测超限，release gate 必须失败。
- 首个流程按 P1a 每目标至少 5 次独立 build/解压 → P3a 真实 installer → P3b 每目标至少 10 次空缓存冷安装执行。size 预算取该目标观测最大值的 1.15 倍并向上取整，cold-install/event-loop 预算取观测 p95 的 1.25 倍并向上取整，`minimumFreeDiskBytes` 至少为 `(maxArchiveBytes + 2 × maxUnpackedBytes) × 1.15`。预算文件不能由同一次 release job 自动扩容；任何调高都必须是独立、可审查的源码 diff，并附新基线报告，之后重新构建 release candidate。
- 现有 installer 防滥用常量必须大于等于 release budget；若真实预算超过防滥用常量，发布保持阻塞，必须显式审查两者，而不是在测试中放宽限制。Main 卡顿通过安装期间的 event-loop delay instrumentation 验证，普通聊天并发 smoke 同时证明下载/解压未阻塞会话。

### 2.5 Plugin/skill 同步的参考行为

Runtime 安装成功后，参考项目先同步 runtime manifest 声明的 bundled plugin marketplace，再复制 bundled skills，最后请求 `skills/list { forceReload: true }`，见 [`main-Cwjv9Ibf.js:96023`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96023>)、[`main-Cwjv9Ibf.js:96036`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96036>) 和 [`main-Cwjv9Ibf.js:96241`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96241>)。其中 marketplace/skill 同步会被安装调用等待；`skills/list` reload 只发请求并记录失败警告，不被等待，见 [`main-Cwjv9Ibf.js:96015`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96015>)。本项目只把 marketplace 中的 PPT plugin 换成获授权的 `presentation-skill`；同步顺序和 app-server 所有权不另造一套。

本项目有意增加一项可靠性加固：active pointer 已提交后，marketplace/skill 同步或 reload 失败不回滚 Runtime 字节，但 UI 不得把 plugin 能力显示为 ready；状态进入 `post_install_failed`，repair 只重跑受影响的同步/reload，必要时再 force reinstall。该加固必须明确区分“Runtime 已激活”和“PPT plugin 已可发现”，避免把参考项目的 fire-and-forget reload 误写成已确认加载。

### 2.6 其余获取/更新主链

参考项目把 renderer 收到的 `codex-runtimes-config-changed` 写入 Main 的共享 `codex_runtimes_config`，见 [`main-Cwjv9Ibf.js:90026`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:90026>)。默认 feed 使用按 target 拼出的 `LATEST.json`，也允许 config 直接内联当前 target release；解析后必须校验 target、OS 和 archive format，见 [`src-PzwkD6WC.js:31461`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31461>)、[`src-PzwkD6WC.js:31908`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31908>) 和 [`src-PzwkD6WC.js:31952`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31952>)。更新器启动时检查 `missing/outdated`，一小时周期内使用持久化 jitter，并由 30 秒 tick 判断是否到期；config/feature 变化会触发重新判断，见 [`main-Cwjv9Ibf.js:95561`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:95561>)、[`main-Cwjv9Ibf.js:95619`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:95619>)、[`main-Cwjv9Ibf.js:95748`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:95748>) 和 [`main-Cwjv9Ibf.js:96428`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96428>)。

参考实现还明确了消费端的运行契约：同参数安装共享 in-flight operation，并在全局串行队列中运行；进度包含 operation ID、下载字节和 phase；错误记录 failure stage、稳定 category/code 和 retryable，只有网络、超时、5xx、408、429 等类别可自动重试，见 [`main-Cwjv9Ibf.js:96188`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96188>)、[`src-PzwkD6WC.js:31331`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31331>) 和 [`main-Cwjv9Ibf.js:96467`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js:96467>)。diagnostics 必须区分“完全未安装”和“目录存在但 metadata 缺失”，见 [`src-PzwkD6WC.js:31489`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31489>)。P3a 以这些可观察行为为验收标准。

参考项目支持 `zip | tar.gz | tar.xz`，并为 `latest-alpha` 的 Windows x64 提供可信 HTTPS `FRAMEWORK.json`/MSIX 分支，见 [`src-PzwkD6WC.js:31917`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31917>) 和 [`src-PzwkD6WC.js:31971`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js:31971>)。本项目 v1 feed 明确只发布 target-specific ZIP，consumer 对其他 format fail-closed；MSIX 不在本轮范围，后续若需要必须另立 ADR，不能静默接受或做未签名降级。

### 2.7 Runtime 生产端与消费端的完整交接契约

参考包公开的是 Runtime config/target 解析、下载、安装和同步逻辑，没有公开制品如何获取 Node/CPython/native/font 输入、如何构建，也没有公开 GitHub Actions、平台签名或 CDN 发布代码。因此本节严格分为“可复用的参考消费契约”和“本项目新增的工程生产契约”，不能把后者写成参考项目事实。

可直接按参考项目实现的部分：target-specific release/`LATEST.json` 或 inline release 解析、archive URL/SHA/format 校验、流式下载与进度、staging 解压、entry 越界拒绝、candidate diagnostics、active 切换失败恢复、启动/定时/manual/repair 更新、plugin/skill 同步以及 `load_workspace_dependencies → 普通命令执行`。对应证据已在第 2.2、2.3、2.5 和 2.6 节给出。

本项目必须自行实现但可完全由代码和 GitHub Actions 验证的部分：source/toolchain lock、内容寻址下载、四目标 input materialization、Node/CPython/native/font 离线闭包、SBOM/notices/provenance、四平台 native load/render、预算测量、engineering metadata 和 GitHub artifact 汇总。对应工程链为：

```text
不可变 source/toolchain lock
  → 受控下载与内容寻址缓存（先校验 SHA/许可证）
  → GitHub Actions 四个目标原生 runner 物化 runtime-inputs/<target>
  → 输入清单/文件哈希/版本/native-load/render 验证
  → P1a 通用 v2 禁发 archive + SBOM + notices + provenance
  → P3a 隔离的真实 installer
  → P3b clean-runner 冷安装/event-loop 测量与独立预算审查
  → 按已审查预算重建四目标 final staging
  → 协调 job 用临时测试密钥生成 engineering config/manifest
  → 组装 production-shaped engineering feed repository
  → 上传四目标 staging、汇总 receipt 与 feed repository 为 GitHub artifacts
  → Electron Main 按第 2.5/2.6 节消费、安装和同步
```

为避免普通 PR/branch push 每次都消耗四目标原生 runner，`.github/workflows/primary-runtime-build.yml` 必须分成三层执行：自动 `pull_request`/`push` 只跑 `fast` source/contract lane；scheduled nightly 和人工 `calibrate` 才跑四目标 P1a/P3a/P3b 校准；人工 `final` 必须绑定已审查的 `calibration_run_id` 后重建四目标 final staging 并汇总 engineering feed。缓存只可覆盖 npm 依赖、按 SHA 内容寻址的 Runtime source objects，以及 Windows 上已通过 `verify:inputs` 的 `runtime-inputs/win32-x64`；后者的 key 必须同时绑定 source/toolchain lock、物化/输入校验脚本、patch、`windows-2025` runner image `ImageVersion`，且不能使用 restore prefix。每次命中仍必须重新执行 `fetch:sources`、`verify:inputs` 和后续 archive/provenance 校验，不能把 cache hit 当作信任证据。

四目标 `build-target` job 必须在 build/platform/provenance 完成后上传 `primary-runtime-<target>-build-artifacts`；独立的同目标原生 `validate-target` job 只能下载本次 run 的固定名 artifact 后执行 P3a/P3b、重新计算 archive SHA，并产生 candidate/final staging。该 artifact 因而可复用耗时编译，但不能替代真实 installer、压力安装、普通聊天、P3b 性能或最终 staging 证据，也不能作为跨 run 的 release 输入。校准 job 预先构建一次桌面测试宿主，P3b runner 只在显式标记且验证 main/preload/renderer 输出均存在时跳过自身的重复 build。Windows 物化必须给每个 `msiexec`、`cmake`/native recipe、tar/zip extraction 输出 start/ok/failed、耗时和命令级 timeout；长时间无输出或单 recipe 卡住时要 fail-fast，并保留足够日志判断是 MSI extraction、native build 还是 closure copy。

工程生产链必须区分五类产物，禁止互相冒充：

1. `source cache`：按 SHA 内容寻址的下载缓存，只是可复用输入，不是 release artifact。
2. `runtime-inputs/<target>`：目标原生 runner 根据锁文件生成的临时、可删除输入根；不得提交 opaque 二进制目录，也不得依赖开发机全局 Node/Python/Office。release 路径必须显式传 `--input-root`，不能依赖仓库里一个事先存在的默认目录。
3. `P1a candidate staging`：禁发 `primary-runtime.zip`、file manifest、SBOM、notices、provenance、component smoke、platform-validation receipt 和 hard-limit/build-unpack measurement；只用于 P3b calibration，不能冒充 production release。
4. `verified final target staging`：预算 diff 提交后重新构建的四目标制品，除上述证据外还绑定 `runtime-budgets.json` SHA 与 P3b performance report SHA。最终 file/archive hash 必须在 archive 完成后生成，不能沿用 P1a candidate hash。
5. `engineering feed artifact`：协调 job 根据四个 final target staging 生成的 config/manifest、不可变 archive 路径和汇总 receipt。metadata 可由本次 run 的临时测试密钥签署以覆盖验签代码；artifact 只包含公钥与签名结果，不包含私钥，并必须带 `releaseClass=engineering`、`publiclyDeployable=false`。

`runtime-sources.lock.json` 不能只锁 npm/Python 源包和 LibreOffice/Poppler 源码 URL。Node runtime、CPython runtime、每个 target 的 native dependency、字体和构建工具链都必须选择一种可审计方式：要么锁定官方 immutable binary 的 URL/SHA/license；要么锁定源码、builder image/toolchain、compiler flags、patch 和产出校验。不能用一个通用源码 URL 代替四平台构建配方，也不能把“CI runner 上碰巧装着”当 Runtime 输入。

### 2.8 生产门禁关闭后的语义

1. `verify:platform` 只证明“该 target archive 在对应 GitHub runner 上能执行、加载 native dependency、调用 LibreOffice/Poppler 并正确使用锁定字体”；它输出 `platform-validation.json`，不得输出或命名为 `trust-receipt`。
2. macOS/Windows 生产身份签名步骤从 build matrix 删除；不得因为缺 Apple/Windows 凭据而让工程 workflow 红灯。本轮不为测试二进制引入 ad-hoc 或其他签名步骤，receipt 只记录 `productionTrust=false`。
3. `primary-runtime-build.yml` 的协调 job 是 engineering feed 的唯一自动生产者；它直接消费同一 run 的四个固定命名 staging，拒绝调用者自由指定 artifact 名称、混用 commit/lock SHA 或缺少 target。
4. `primary-runtime-publish.yml` 在本轮只允许“验证并重新组装为 GitHub artifact”，不得持有生产私钥、云写权限或公开部署步骤。不存在 `.github/workflows/primary-runtime-deploy.yml` 的本轮交付要求。
5. 客户端签名/sequence/origin 校验代码仍必须有单测和本地 feed E2E：CI 临时密钥证明正向路径，篡改 metadata、错误公钥、sequence 回退和非法 origin 证明 fail-closed。这是协议正确性证据，不是生产信任证明。
6. 本计划结束时只能报告 `engineering_complete`。`production_ready` 必须由后续计划补齐生产签名身份、密钥托管、真实信任回执、公开 origin/CDN 发布与回读后才能使用。

## 3. 当前实现状态与剩余差异

状态只使用四类：`已存在/需保持`、`已存在/需迁移`、`未实现`、`外部证据阻塞`。后续实施以“剩余差异”列为工作清单，不能因为类或测试文件已经存在就把整项标成完成。

| 能力面 | 当前证据 | 状态 | 剩余差异 |
| --- | --- | --- | --- |
| Runtime 输入获取与目标物化 | [`build-runtime.mjs:33`](../../primary-runtime/scripts/build-runtime.mjs:33) 直接读取现成 `inputRoot`；[`primary-runtime-build.yml:71`](../../.github/workflows/primary-runtime-build.yml:71) checkout 后立即 build，没有生成该目录 | 未实现 | 增加完整 source/toolchain lock、受控 fetch、四目标原生物化、输入 manifest 与 `verify:inputs`；release build 必须显式接收已验证 `--input-root` |
| Runtime 可执行输入锁定 | [`runtime-sources.lock.json:78`](../../primary-runtime/runtime-sources.lock.json:78) 已锁部分 npm/Python/native/font 来源，但没有 Node/CPython runtime 与四目标 binary/build recipe；[`runtime-fonts.lock.json:1`](../../primary-runtime/runtime-fonts.lock.json:1) 仍为空 | 已存在/需迁移 | 锁定解释器、native binary 或可复现配方、builder/toolchain/flags、字体文件和每目标输出 hash；禁止系统依赖补位 |
| 四平台验证与 target staging | [`primary-runtime-build.yml:44`](../../.github/workflows/primary-runtime-build.yml:44) 已有四目标 matrix，但 arm64 仍用待迁移的 `macos-14`，且 [`verify-platform-trust.mjs:27`](../../primary-runtime/scripts/verify-platform-trust.mjs:27) 仍是生产信任占位 | 已存在/需迁移 | 固定四个 GitHub-hosted 原生 runner；将占位脚本改成无凭据的 `verify:platform`，输出 native load/ABI/LibreOffice/Poppler/font render 的 `platform-validation.json`，不要求真实签名或 trust receipt |
| 工程 feed metadata 与汇总 | [`primary-runtime-publish.yml:10`](../../.github/workflows/primary-runtime-publish.yml:10) 仍要求人工提供 `metadata_artifact` 和四个 artifact 名称 | 已存在/需迁移 | 由 build workflow 的协调 job 自动消费同一 run 的四个固定 staging，生成 test-signed engineering config/manifest、篡改拒绝证据和汇总 receipt；临时私钥不上传 |
| GitHub artifact 交付 | [`primary-runtime-publish.yml:123`](../../.github/workflows/primary-runtime-publish.yml:123) 已能上传待部署 repository artifact，但名称和描述仍暗示生产发布 | 已存在/需迁移 | 仅组装并上传 `primary-runtime-engineering-feed` GitHub artifact，写入 `releaseClass=engineering`/`publiclyDeployable=false`；删除真实 origin/CDN、canonical promotion 与 deploy workflow 的本轮要求 |
| installer、active pointer、release provider | `PrimaryRuntimeInstaller` 已流式安装并有防御上限；active pointer 和签名 release provider 已存在 | 已存在/需迁移 | 对齐 reference-shaped inline/immutable-manifest、staging/diagnostics/switch 可观察语义，区分 calibration/release 模式并接入 hard-limit 与按目标 release budget |
| updater | [`PrimaryRuntimeUpdateCoordinator.ts:27`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeUpdateCoordinator.ts:27) 已有串行协调器 | 已存在/需迁移 | 补齐 config/feature/host disabled reasons、inline/immutable-manifest target resolution、启动 missing/outdated、持久化 hourly jitter、30 秒 due tick、manual/repair/cancel、共享 in-flight 的参考契约 |
| activation transaction / capability policy | [`PrimaryRuntimeActivationTransaction.ts:134`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivationTransaction.ts:134) 和 [`PrimaryRuntimeCapabilityPolicy.ts:20`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeCapabilityPolicy.ts:20) 已存在 | 已存在/需迁移 | 保留能证明失败不改变 active 的部分；删除或降级参考项目没有要求的 generation/admission 前置条件，不能写成“待新增” |
| manifest/diagnostics | [`PrimaryRuntimeManifest.ts:68`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts:68) 已支持旧 v2，但强制 `artifactToolVersion` | 已存在/需迁移 | 拆成通用 v2 与只读 legacy-v2 decoder/diagnostics/desired-set，补升级失败保留旧 active 测试 |
| loader | [`desktopToolDefinitions.ts:70`](../../desktop-app/src/main/appTools/desktopToolDefinitions.ts:70) 已在 Runtime 未 ready 时发布；[`PrimaryRuntimeService.ts:659`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts:659) 仍返回 `root` 和 package inventory | 已存在/需迁移 | 保持“ready 不影响 schema”，由 Main 单一所有者查询并按 host/connection generation 缓存 product/app-server feature gate，改为参考式白名单 instruction text 和稳定失败 |
| 安装进度、错误与后安装状态 | 当前已有进度与安装错误对象，但没有完整证明 reference phase/stage/category/retryable 与“Runtime active / plugin ready”双状态 | 已存在/需迁移 | 固定 operation/call ID、phase、failure stage/category/code/retryable、safe/sensitive telemetry；post-install 失败不回滚 active，但 UI 不得报告 plugin ready |
| bundled plugin/skill reconcile | [`BundledPluginDescriptors.ts:223`](../../desktop-app/src/main/bundledPlugins/BundledPluginDescriptors.ts:223) 已能从 active Runtime 发现 marketplace | 已存在/需迁移 | 改用授权 PPT plugin，固定 marketplace → skills remove/copy → forceReload 顺序，并隔离用户 plugin；明确 reload 是本项目额外等待/重试加固 |
| deterministic/live tests | synthetic feed runner、real feed E2E 和 R07 已存在；real feed 仍在 [`primary-runtime-feed.e2e.ts:176`](../../desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:176) 查找私有包，R07 仍在 [`release-llm.e2e.ts:224`](../../desktop-app/tests/e2e/release-llm.e2e.ts:224) 强制旧 Presentations 链 | 已存在/需迁移 | synthetic 只保留非发布回归；P5/P6/P7 分别迁移 host fixture、real feed 和 R07/release gates，改为授权 plugin、普通 command、新建 PPTX + QA + preview，并补资源预算测量 |
| hard limits、`runtime-budgets.json` 与 performance gate | [`runtime-budgets.json`](../../primary-runtime/runtime-budgets.json) 和 verifier/runner 入口已存在，但当前数值没有绑定“P1a 每目标 5 次 build/解压 → P3a installer → P3b 10 次冷安装”的 clean-runner lineage，也没有独立 candidate hard-limit | 已存在/需迁移 | 新增不可自动放宽的 hard limits；建立顺序 workflow gate、四目标 measurement receipt、独立预算审查 commit、event-loop instrumentation、最终重建和 fail-closed release binding |
| 授权 plugin source lock | [`runtime-sources.lock.json:5`](../../primary-runtime/runtime-sources.lock.json:5) 已锁定通过 P0 选择的 `v0.8.0` tag/commit/archive/tree/patch 与最小依赖闭包，拒绝的 `v0.11.0` 也有原因记录 | 已存在/需保持 | source-lock/许可证 gate 必须继续 fail-closed；P1a 扩充解释器、工具链、native binary 与字体锁时不能破坏已审计 plugin 坐标 |
| 四目标真实 archive 与工程安装介质 | 当前没有自动生成 input root、四目标 `platform-validation.json` 或自动 engineering metadata producer | 未实现 | 完成 P1a/P3b/P7 的四目标实包、SBOM/provenance、预算、GitHub artifact feed 和 packaged R07；真实签名、trust receipt 与公开 CDN 不属于本计划 blocker |
| 计划真相源 | 本文已重写；synthetic 文档仍曾包含私有包恢复条件 | 已存在/需保持 | 本次已把 synthetic 文档改为被取代说明；ADR、feed spec、source lock 和代码 gate 仍须在 P0/P1a 迁移 |

## 4. 目标架构

```text
source + toolchain locks
              │
              ▼
GitHub Actions target-native matrix
  macos-15-intel / macos-15 / windows-2025 / ubuntu-24.04
              │
              ▼
target-native input materializer
  fetch/cache → SHA/license → patch → runtime-inputs manifest → native smoke
              │
              ▼
platform validation → file manifest → P1a 禁发 Runtime ZIP/SBOM/provenance
              │
              ▼
P3a isolated real installer → P3b cold-install/event-loop calibration
              │
              ▼
independent budget review → rebuild final candidate
              │
              ▼
CI-ephemeral test signing → engineering config/manifest tamper tests
              │
              ▼
GitHub artifact: primary-runtime-engineering-feed
  inline release or immutable manifest URL + bundleVersion/format/archive/SHA/budget
              │
              ▼
Electron Main PrimaryRuntime updater
  startup check + hourly jitter + manual update/repair + cancel
              │
              ▼
download to staging → progress → SHA → entry check → extract → diagnose
              │
              ▼
atomic active switch（失败保留旧 active）
              │
              ├─ sync bundled PPT plugin marketplace
              ├─ sync/remove Runtime-owned skills
              └─ skills/list forceReload
              │
              ▼
load_workspace_dependencies
  返回 Node / Node modules / Python / Python packages / binaries 文本说明
              │
              ▼
real app-server 普通命令链执行 presentation-skill 脚本
              │
              ▼
PPTX → render / QA / workspace preview
```

不变量：

1. Runtime 下载和安装只由 Electron Main 持有；Renderer 不接收 feed secret、archive path、active root 或任意文件系统入口。
2. archive 在 candidate 完成 SHA、entry 和 dependencies diagnostics 前不得改变 active。
3. loader 只在 local host、product feature 与 app-server `workspace_dependencies` feature 同时启用时发布；Main 单一所有者按 host/connection generation 提供该状态。是否安装成功由调用结果表达，不以临时 ready 状态改变工具 schema。
4. loader 只给出参考项目同类的受控路径说明；plugin 通过正常命令链使用这些路径。
5. bundled plugin marketplace、bundled skills 与 active Runtime 来自同一份已诊断 manifest；同步失败时安装操作不得报告 ready，repair 重试同步。
6. plugin 及其 Node/Python/native/font 依赖随 Runtime archive 离线提供；不访问 npm、PyPI、GitHub 或模型 HTTP API。
7. MCP/Native Pipe 只是 `DynamicAppToolRegistry` 的兼容投影；移除该兼容入口后，原生 app-server tool/command 路径仍能完成流程。
8. 本轮只从非 PPTX 工作区输入新建 PPTX，并执行 QA/预览；任何既有 PPTX 修改都不会进入产品声明、tool contract 或 release gate。
9. 四目标各自有两层资源边界：P1a 先使用不能由构建自动改写的 hard-abuse limits 生成禁发候选，P3b 再用真实 installer 的 clean-runner 测量生成候选预算报告，由独立审查者提交 release budget 后重建最终候选。缺目标、缺字段、未绑定测量报告或实测超限都阻塞 engineering artifact 汇总；这些数值属于本项目 release hardening，不冒充参考项目参数。
10. clean checkout 的目标 runner 必须能从锁文件和获准网络/source cache 自动生成 `runtime-inputs/<target>`；手工准备目录、开发机全局依赖和未绑定 CI artifact 都不是合法输入。
11. 每次工程交接都通过不可变 digest 绑定上一步：input manifest → file manifest → archive/provenance → budget report → engineering config/manifest；协调 job 不能替换 target artifact 或扩预算，测试签名私钥不得离开临时目录。
12. 本轮 feed 只接受 target-specific ZIP；参考项目的 tar/MSIX 分支只作为消费端行为证据，不进入本项目 v1 发布面。
13. 参考项目的 `.previous` 恢复用于本机 Runtime 字节事务：candidate/active 切换失败恢复旧 active。sequence 防回滚由测试密钥和本地 feed E2E 验证；公开后的 forward-recovery 不属于本轮交付。
14. engineering feed 使用不可变、带 version/digest 的 archive 路径，并可同时覆盖 config inline release 与 target-specific manifest fallback。它只在 CI/本地测试服务器中消费，不形成公开 production channel 或 CDN 指针。
15. workspace dependencies feature 状态由 Main 单一所有者通过 AI-free client 查询 app-server，按 host 与 connection generation 缓存；产品配置、feature 配置或 connection generation 变化会失效缓存。查询错误 fail-closed，只影响新 thread 的 capability snapshot，不热改已有 thread。

## 5. Implementation Steps

### P0：冻结参考契约与替换边界

涉及：

- 更新 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md`
- 更新 `docs/specs/primary-runtime-feed-v1.md`
- 更新 `primary-runtime/runtime-sources.lock.json`
- 更新 `primary-runtime/scripts/source-lock.mjs` 与 `primary-runtime/tests/build-runtime.node-test.mjs`
- 更新 `primary-runtime/README.md` 与 `services/primary-runtime-feed/README.md`
- 维护 `.omx/plans/primary-runtime-synthetic-feed-execution-plan.md` 的“已被本文取代”归档说明，禁止重新形成第二份生产执行计划

工作项：

1. ADR 明确唯一能力差异是 PPT plugin；loader、update、activation、plugin sync 和执行方式采用本计划第 2 节的参考契约。
2. 对 `siril9/presentation-skill` 执行阻断式选择门：确认仓库/发布者身份、根许可证、指定 tag 对应的完整 40 位 commit、source archive SHA256、目录内容哈希、依赖调用图、npm/Python/native/font 传递依赖及许可证。若任一项不能证明可再分发，P0 以 `candidate_rejected` 结束；必须先显式修改本文候选和 source lock，不能进入 P1a 或由执行 AI 临时换包。
3. source lock 固定通过审计的 plugin name、tag、完整 commit、source archive SHA256、本项目 patch SHA256、每项 npm/Python/native/font 来源/版本/SHA/许可证；禁止 `main`、`master`、HEAD、范围版本、latest、缺失 SHA 或 `TBD`。`source-lock.mjs` 与测试必须 fail-closed 验证这些字段，根项目 MIT 不能替代传递依赖审计。
4. 删除 ADR、feed spec、两份 README 和 source-lock gate 中“必须取得 `@oai/artifact-tool`/OpenAI Presentations 私有包”以及“新增 PPT 专用 Main 执行工具”的正向要求；旧包名只允许出现在 migration/negative test。host/feed/live E2E 与 release gate 的代码迁移分别归 P5、P6、P7，不在 P0 用模糊的“代码 gate”一笔带过。
5. ADR、feed spec 和 README 必须明确区分 `engineering_complete` 与 `production_ready`：本计划保留 metadata 验签、sequence 防回滚、origin allowlist 和不可变 archive 路径的代码/测试契约，但只使用 CI 临时测试密钥与本地 feed 验证；Apple/Windows 生产签名、生产 key custody、信任回执、canonical production promotion、forward-recovery 和公开 CDN 均移入后续 Production Readiness 计划，不得继续阻塞 P1a-P7。

验收：P0 输出的 source lock 不含 placeholder/floating ref，记录可复算的 plugin/patch/dependency SHA 与逐项许可证，且 `source-lock.mjs`/单测会拒绝任一字段缺失或变成范围值。ADR、feed spec、README、两份计划使用同一组术语；旧包名只出现在迁移/negative test；所有文档都声明 GitHub artifact 不是生产发布物，缺生产签名/CDN 凭据不再形成工程 blocker。P0 未通过 source/许可证机器校验时状态仍为 `外部证据阻塞`。

### P1a：从锁定来源生产四目标禁发候选制品

涉及：

- `primary-runtime/runtime-toolchains.lock.json`（新增）
- `primary-runtime/runtime-inputs.schema.json`（新增）
- `primary-runtime/scripts/fetch-runtime-sources.mjs`（新增）
- `primary-runtime/scripts/materialize-runtime-inputs.mjs`（新增）
- `primary-runtime/scripts/verify-runtime-inputs.mjs`（新增）
- `primary-runtime/scripts/build-runtime.mjs`
- `primary-runtime/scripts/verify-runtime.mjs`
- `primary-runtime/scripts/verify-runtime-platform.mjs`（新增；取代生产信任占位脚本）
- `primary-runtime/scripts/verify-runtime-hard-limits.mjs`（新增）
- `primary-runtime/runtime-hard-limits.json`（新增；仅作为不可自动放宽的候选防滥用边界）
- `primary-runtime/tests/runtime-inputs.node-test.mjs`（新增）
- `primary-runtime/tests/runtime-hard-limits.node-test.mjs`（新增）
- `primary-runtime/package.json`
- `primary-runtime/runtime-sources.lock.json`
- `primary-runtime/runtime-fonts.lock.json`
- `primary-runtime/resources/plugins/presentation-skill/**`
- `.github/workflows/primary-runtime-build.yml`
- `desktop-app/scripts/tests/release-workflow.node-test.mjs`

工作项：

1. 扩充 source/toolchain lock。除 plugin 和 npm/Python 包外，必须锁定 Node runtime、CPython runtime、LibreOffice、Poppler、字体及 native modules 的每目标 immutable binary URL/SHA/license，或锁定可复现源码构建配方、builder image digest、编译器/SDK 版本、flags 和 patch SHA。任何“使用 runner 预装版本”、floating package index、未锁定 wheel/npm install 或通用源码 URL 都 fail-closed。
2. `fetch-runtime-sources.mjs` 只把 lock 声明的对象下载到 SHA 内容寻址 cache；下载完成先核对 digest、size 和许可证 receipt，再允许物化。缓存命中也重新核对 hash；脚本不得执行来自下载包的任意安装 hook，也不得从 lock 外补依赖。
3. `materialize-runtime-inputs.mjs` 在对应 target 的原生 clean runner 上生成临时 `runtime-inputs/<target>`。它解包/构建解释器和 native binary，以离线方式安装锁定 npm/Python 闭包，复制字体，展开锁定 plugin snapshot 并应用精确 patch；必要 patch 只处理离线路径、宿主 imagegen handoff、禁止直接模型 HTTP、禁止自建 venv/在线安装和系统依赖发现。
4. 物化阶段生成 `runtime-inputs.manifest.json`：记录 target、source/toolchain lock SHA、builder/version、每个输入组件、每个文件的 path/mode/SHA、patch SHA、许可证和构建 receipt。`verify-runtime-inputs.mjs` 拒绝缺文件、额外未绑定文件、符号链接逃逸、错误目标、错误可执行格式/版本以及目录外依赖；四目标分别执行 Node/Python import、native module load、LibreOffice/Poppler 和中文字体 render smoke。
5. 每个目标 input root 只包含该目标需要的 `dependencies/node`、`dependencies/python`、`dependencies/native`、字体和 Runtime-owned Codex plugin marketplace。Runtime 预置并核验 PptxGenJS、JSZip、`sharp`、所需 Python packages、LibreOffice/Poppler 和字体；具体 required set 以 plugin 实际调用图为准，不复制旧 `@oai/artifact-tool` 清单。
6. 修改 `build-runtime.mjs`：工程/发布候选模式强制显式 `--target` 与 `--input-root`，并核对 input manifest；仓库默认 `resources/runtime-inputs/<target>` 只能作为单测 fixture，不能进入 GitHub Actions artifact workflow。`.github/workflows/primary-runtime-build.yml` 的固定顺序是 `fetch → materialize → verify:inputs → build → verify archive/component smoke → verify:platform → upload target staging`，不能 checkout 后直接 build。当前只传 `--matrix` 实际仍落到本机 target 的 `build:matrix`/`verify:matrix` 必须删除，或改成只汇总四个 native-runner receipt 的 coordinator，不能继续给出“本机已构建四目标”的假象。
7. `verify-runtime-platform.mjs` 在 archive 完成后于对应原生 runner 解压并验证：目标/可执行格式与版本、Node/Python 执行、native module load、动态库闭包、LibreOffice/Poppler、锁定中文字体解析与 render。输出固定 schema 的 `platform-validation.json`，包含 target、runner image、archive SHA、各项 command/result SHA 和 `productionTrust=false`。删除 `verify:platform-trust` 与无条件抛错的生产占位；不新增 `sign:inputs`、不读取 Apple/Windows 证书，也不把任何签名步骤作为加载或验收前置。
8. 输出通用 format v2 `runtime.json`、target ZIP、file manifest、SBOM、THIRD_PARTY_NOTICES、source/provenance receipt、component smoke、platform validation 和 target compatibility。`provenance.json` 至少绑定 desktop/runtime commit、target、source/toolchain/input/file manifest SHA、runtime manifest SHA、archive SHA/size、SBOM/notices SHA、patch SHA、component smoke SHA、platform-validation SHA、builder identity 和 workflow run；上传 artifact 只包含已声明 staging 文件，禁止临时 cache、测试私钥或未登记内容。
9. 新增并人工审查 `runtime-hard-limits.json`，固定四目标 archive、unpacked 和 minimum-free-disk 的候选防滥用上限；构建脚本只能读取，不能自动生成或放宽。新增 `verify-runtime-hard-limits.mjs`、单测和 `verify:hard-limits` package script，拒绝缺目标、非正整数、schema 漂移或构建修改。它不是 release budget，不能单独满足 engineering artifact 汇总门禁，也不能包含依赖尚未实现的 cold-install/event-loop 最终阈值。
10. 首个候选禁止冒充生产发布；每个 target clean runner 至少执行 5 次独立 build/解压，输出绑定 source/toolchain/input/file manifest、archive SHA 和 runner identity 的 P1a measurement receipt。真实空缓存安装、并发聊天和 event-loop 测量明确推迟到 P3b，在 P3a installer 完成后执行。

验收：全新 checkout 在 `macos-15-intel`、`macos-15`、`windows-2025`、`ubuntu-24.04` 四个 GitHub Actions runner 上，只凭已审查 lock 和获准 source cache/网络即可自动生成 input root；删除该目录后重跑仍可复现相同 input manifest。四目标禁发候选 archive 都能离线通过 diagnostics 和 `verify:platform`，并由 Runtime 内 plugin 脚本从非 PPTX 输入新建至少 3 页、含中文/表格/图表/图片的 PPTX；无手工输入目录、用户 cache、系统 Node/Python/Office 或联网安装依赖。四目标 archive/unpacked 实测不超过 hard limits，且 P1a receipt 足以供 P3b 复核；没有 Apple/Windows 生产签名或 trust receipt 不影响本阶段通过。

### P2：把 manifest/diagnostics/loader 从旧包身份改成通用 v2 Runtime

涉及：

- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeDiagnostics.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts`
- `desktop-app/src/main/primaryRuntime/primaryRuntimeTypes.ts`
- `desktop-app/src/main/appTools/desktopToolDefinitions.ts`
- 对应 unit tests

工作项：

1. 新增通用 format-v2 parser；旧 `artifactToolVersion` parser 保留为显式、只读的 `legacyV2` 分支。两者共享 format-v2 文件布局，但 readiness 规则不同。
2. 新 diagnostics 按 manifest 声明逐项验证 Node、Node modules、Python、binaries、plugin marketplace 和关键 source digest；不得再硬编码查找 `@oai/artifact-tool`。
3. `loadDependencies()` 内部可以保留完整路径对象，但 model-visible formatter 必须输出参考项目式 instruction text，移除 `root` 和内部 package inventory 字段。
4. legacy v2 若仍健康可被识别，但因为 desired `bundleVersion` 已变化会进入 outdated；只读 legacy desired-set 让旧 active 在升级失败时保持可诊断/可用，升级成功后退出该 desired-set，且不承诺旧 PPT 引擎仍可调用。

验收：通用 v2 ready、legacy v2 readable/outdated、坏 v2 broken、target mismatch unsupported 都有 fixture；新输出与参考字段集合一致。

### P3a：补齐参考项目式更新与安装生命周期

涉及：

- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeUpdateCoordinator.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts`
- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivePointer.ts`
- `desktop-app/package.json`
- `desktop-app/src/main/index.ts`
- 对应 unit/integration tests

工作项：

1. 接收 product-owned runtime config。先使用 config 内联的当前 target release；缺失时请求 config 指向的 target-specific immutable manifest，并保留参考项目 `LATEST.json` 形状的兼容解析测试。manifest/release 必须同时通过工程 metadata 验签、sequence/expiry/origin allowlist、target、OS compatibility、bundle format、archive URL/SHA/size/budget 和 provenance binding 校验，任一不符在下载前失败。正向 E2E 使用 CI 临时测试密钥与本地 feed，不能因此声明生产信任。
2. 固定禁用原因：`not-local-host`、`runtime-config-missing`、`product-feature-disabled`、`workspace-dependencies-feature-disabled`、`unsupported-host`。禁用时不得访问 feed；config 或 product/app-server feature 变化清除相关缓存并立即重新判断是否到期。
3. 启动立即检查；`missing/outdated` 安装，`current/unsupported` 不操作。之后按一小时周期加持久化 jitter 计划，30 秒 tick 只判断是否到期，不每次访问网络。
4. manual update、repair、scheduled update 共用串行队列；相同 `forceReinstall + release + target + options` 共享一个 in-flight operation。每个 API call 有 call ID，每个底层安装有 operation ID；调用者加入已有操作时复用 operation ID，不重复下载。cancel 是合作式取消，只影响当前可取消阶段；无活动操作时稳定返回未取消。
5. 进度模型固定为 `resolving → checking → downloading → verifying → extracting → validating → activating → configuring → ready | error`，下载阶段携带 `downloadedBytes` 与可选 `totalBytes`，所有事件携带 operation ID、release、target 和 bundleVersion（未知时为 null），由 Main 广播给所有窗口。内部 stage 另记录 `resolve_manifest | create_staging_directory | prepare_archive | download_archive | verify_checksum | list_archive | extract_archive | validate_payload | activate_runtime | validate_cached_runtime | sync_plugins | sync_skills | reload_skills | cleanup`。
6. 错误合同固定为 `aborted | unsupported_host | invalid_manifest | disk_full | permission_denied | network_fetch_failed | timeout | checksum_mismatch | http_client_error | http_server_error | archive_processing_failed | validation_failed | post_install_failed | filesystem_error | unknown`，并携带 errorCode、failureStage、failureDomain 和 retryable。只有网络、timeout、5xx、408、429 类可自动重试；checksum、validation、permission、disk、metadata signature/sequence/origin 类必须等待修复或新 engineering release。遥测把 operation/call/trigger/release/target/stage/category 放 safe 区，URL query、header、本机路径和原始错误放 sensitive 区并受脱敏策略约束。
7. installer 按 `staging → SHA → entry check → extract → candidate diagnostics → atomic switch → active diagnostics → cleanup` 执行。当前 active pointer 可作为 rename/swap 的等价实现，但测试必须证明 candidate 验证和 active commit 失败不改变旧 active；diagnostics 明确区分 not-installed、metadata-missing、broken 和 target-unsupported。
8. active pointer 提交是 Runtime 字节事务的终点；之后进入 `configuring`，执行 P4 的 plugin/skill/reload。post-install 失败不回滚已验证 active，也不能报告整体 capability ready；状态记录 `runtimeActive=true, pluginReady=false, failureDomain=post_install`，repair 优先重试配置，必要时再 force reinstall。
9. `repair/reset` force reinstall 当前 release；不实现持久多版本回滚 UI。缓存旧 archive/version 的清理是存储策略，不是兼容契约。
10. 下载流式写盘，`Content-Length` 可选；SHA 必须；越界 entry 必须拒绝；取消/失败清理 staging；`ENOSPC` 归类为 disk_full。installer 始终执行 `runtime-hard-limits.json`；普通 engineering release 模式还必须取得 metadata 绑定的 `runtime-budgets.json`，并验证 release budget 不高于 hard limit。只有 CI calibration 模式可以在 release budget 尚未定稿时安装 P1a 禁发候选，该模式不得连接非本地 feed、更新用户正常 active pointer 或生成 `production_ready` 状态。
11. 普通聊天不得等待 Runtime 更新；Runtime 错误只降级 workspace dependencies/PPT 能力。本轮只实现 ZIP；tar/MSIX manifest 必须在解压或框架安装前返回 unsupported-format，不做隐式 fallback。

验收：inline release、target-specific manifest/`LATEST.json` 兼容解析、全部 disabled reason、startup missing、scheduled outdated、manual current/update、repair、cancel、共享 in-flight、完整 phase/stage/error/retryable、offline、bad SHA、metadata 篡改、sequence 回退、非法 origin、path traversal、candidate diagnostics failure、active commit failure、post-install failure、ENOSPC、ZIP-only、hard-limit/release-budget 缺失或超限都证明 active 的参考语义；普通 engineering release 模式不能借 calibration 模式绕过 metadata 验签、预算或正常 active pointer 约束。

### P3b：真实冷安装校准与最终 release candidate 重建

涉及：

- `primary-runtime/scripts/calibrate-runtime-budgets.mjs`
- `primary-runtime/scripts/verify-runtime-budgets.mjs`
- `primary-runtime/tests/runtime-budgets.node-test.mjs`
- `primary-runtime/runtime-budgets.json`
- `desktop-app/scripts/run-primary-runtime-performance.mjs`
- `desktop-app/scripts/tests/primary-runtime-performance.node-test.mjs`
- `desktop-app/package.json`
- `.github/workflows/primary-runtime-build.yml`

工作项：

1. P3b 只能在 P1a 四目标禁发候选及其 measurement receipt 完整、P3a 真实 installer 与 calibration 隔离边界验证通过后启动；workflow contract test 必须拒绝跳过任一前置阶段。
2. 新增 `run-primary-runtime-performance.mjs` 和 runner contract test，在 `desktop-app/package.json` 注册 `test:primary-runtime:performance`。每个 target clean runner 从空 cache 通过 production-shaped 本地 feed 和真实 installer 执行至少 10 次独立冷安装，安装期间并发执行普通聊天 smoke，采集 cold install、Main event-loop p99/max、archive、unpacked 和 minimum-free-disk 数据；报告绑定 P1a candidate archive SHA、source run、target、installer commit 和 hard-limit SHA。
3. `calibrate-runtime-budgets.mjs` 只读取四目标 P1a build/unpack receipt 与 P3b cold-install/event-loop report，校验目标、候选 digest 和 runner identity 一致后输出候选预算报告，不直接改源码。archive/unpacked 上限取目标观测最大值的 1.15 倍向上取整，cold-install/event-loop 上限取观测 p95 的 1.25 倍向上取整，minimum-free-disk 至少为 `(maxArchiveBytes + 2 × maxUnpackedBytes) × 1.15`，且所有 release budget 都不得高于 hard limit。
4. 审查者在与测量 job 分离的 commit 中提交 `runtime-budgets.json` numeric diff；`verify-runtime-budgets.mjs` 和单测校验 schema、四目标完整性、正整数、公式下限、hard-limit 包含关系、测量报告绑定及实测不超限。同一次 release job 不得生成或放宽预算。
5. 预算提交后必须从同一 source/toolchain lock 重新构建四目标最终 release candidate，再用真实 installer 复跑预算验证。最终 archive/provenance/metadata 必须绑定已审查 budget file SHA 和对应 performance report SHA；P1a 禁发 candidate 不得直接提升。

验收：四目标均有 5 次 build/解压与至少 10 次真实空缓存安装证据，普通聊天 smoke 通过，cold-install/event-loop 指标不超预算；预算由独立 numeric diff 提交，最终 release candidate 是预算提交后的重建结果，并完整绑定 hard-limit、budget、measurement 与 archive digest。

### P4：按参考顺序同步 bundled plugin/skill

涉及：

- `desktop-app/src/main/bundledPlugins/BundledPluginDescriptors.ts`
- `desktop-app/src/main/bundledPlugins/BundledPluginManager.ts`
- `desktop-app/src/main/bundledPlugins/BundledPluginReconcileCoordinator.ts`
- AI-free client 的 plugin/skills 调用与测试

工作项：

1. 从 active Runtime diagnostics 读取 bundled marketplace paths，调用现有 app-server plugin catalog/install 能力同步授权 PPT plugin。
2. 同步 Runtime-owned bundled skills，并安全移除 manifest 明确列出的 legacy skills；路径必须限定在 Codex skills root 内。
3. 完成后调用 `skills/list { forceReload: true }`。参考项目只发起 reload 并记录警告；本项目作为显式可靠性加固，必须等待 reload 成功或进入可诊断的 `post_install_failed`，在此之前 capability 不报告 ready。plugin/skill/reload 失败不回滚已经通过 active diagnostics 的 Runtime 字节，repair 从失败阶段重试。
4. 不发明 per-thread skill generation、candidate-disabled plugin staging 或跨 pointer/plugin 的持久事务；若将来有真实产品问题，另立 ADR，不把它们写成参考复刻条件。
5. 用户安装的同名或其他 plugin 不得被 Runtime 清理逻辑误删；Runtime-owned 来源必须可区分。

验收：首次安装、升级、旧 Runtime skill 移除、plugin sync/reload 失败后 `runtimeActive=true, pluginReady=false`、repair、用户 plugin 保留、`skills/list` reload 均有集成证据；任何后安装失败都不伪造 ready，也不把 active pointer 回滚到旧包。

### P5：对齐 loader 发布与真实执行链

涉及：

- `desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts`
- `desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts`
- `desktop-app/src/main/appTools/desktopToolDefinitions.ts`
- `desktop-app/src/main/appTools/DynamicAppToolRegistry.ts`
- `desktop-app/src/main/codexRun/NativeCodexRunDriver.ts`
- `desktop-app/src/main/codexChatRuntimeService.ts`
- `desktop-app/vendors/codex-app-server-client/src/history-client.ts`（复用既有 `experimentalFeature/list`，只补 contract test 时修改）
- `desktop-app/tests/e2e/app-tools-host.e2e.ts`
- 对应 Main/app-server contract tests

工作项：

1. loader 的 catalog eligibility 只取决于 local host、产品 feature 和 app-server `workspace_dependencies` feature，不取决于此刻 Runtime ready。Main 由 `PrimaryRuntimeService`（或其中单一、Main-owned 的内部 feature-state component）负责组合这些条件；Renderer、appTools registry 和 Runtime installer 不各自维护第二份 feature 真相源。
2. Main 通过 AI-free client 既有 `experimentalFeature/list` 分页查询 app-server；查询结果以 `{hostId, connectionGeneration}` 为缓存键并共享同一个 in-flight Promise。产品 feature/config 变化、app-server connection generation 变化或查询失败都清除对应缓存；错误、超时、未知 feature、分页不完整一律 fail-closed 为 disabled，并且禁用状态下不得访问 Runtime feed。
3. 新 thread 创建不可变 capability snapshot 前解析一次组合 gate，再把布尔结果注入 `DesktopToolContext`/registry projection；恢复旧 thread 沿用原 snapshot，不热加、热删 dynamic tools。测试覆盖 enabled、product-disabled、app-server-disabled、unknown、分页命中、查询错误、重复请求共享、配置变化和 reconnect generation 刷新。
4. loader 无参数、只读；ready 时返回参考项目式 instruction text，missing/broken/disabled 时返回稳定失败文本。详细修复状态继续由 Plugin Center/Main status API 提供。
5. plugin `SKILL.md` 明确：先调用 loader，再使用 loader 指定的 Node/Python/module/binary paths；不得猜测 Runtime root、调用系统路径或在线安装。
6. PPT 脚本通过 app-server 正常 command approval/execution 运行。若存在 Runtime shim，也只是普通被锁定脚本，不注册为新的 dynamic tool。
7. 保持新 thread 的 dynamic tools snapshot 与 resume 边界；不向恢复中的旧 thread 伪造或补发工具。当前产品版本创建的本地 thread 应从一开始就有 loader，因此不再引入 `new-thread-required` workaround。
8. 关闭 MCP/Native Pipe 兼容投影后，原生 loader tool call + command execution 仍通过。
9. 把 `app-tools-host.e2e.ts` 中对 `@oai/artifact-tool`、顶层 `root` 和旧 package inventory 的正向 fixture/assertion 迁移为通用 v2 manifest 与参考式白名单 instruction text；旧字段只保留在明确的 legacy/negative 用例中。

验收：Main-owned feature 查询/分页/缓存/失效/重连、tool catalog gating、ready/missing/broken output、无 root 字段、正常命令审批、Pipe-off 原生链、new-thread snapshot 与 resume 不补发工具全部通过；任何 feature 查询异常都稳定 fail-closed 且不访问 feed。

### P6：建立真实 feed/Runtime 的确定性 Electron E2E

涉及：

- `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts`
- `desktop-app/scripts/run-primary-runtime-feed-e2e.mjs`
- `desktop-app/tests/e2e/support/app.ts`
- `desktop-app/tests/e2e/support/mockBackend.ts`
- `desktop-app/scripts/run-presentations-runtime-smoke.mjs`
- `desktop-app/scripts/tests/primary-runtime-feed-e2e.node-test.mjs`
- `desktop-app/scripts/verify-app-tools-release-gates.mjs`
- `desktop-app/scripts/tests/verify-app-tools-release-gates.node-test.mjs`

约束：只允许 mock 外部模型 HTTP；Renderer、Preload、Main、release/update/install、真实 app-server、native tool dispatcher、command execution、plugin sync 和 Runtime archive 全部使用生产实现。测试从空 userData/CODEX_HOME/cache 开始，不设置 direct Runtime root 或 app-server 替身。

用例：

1. 从协调 job 生成的 production-shaped 本地 HTTP/HTTPS static feed artifact 取得目标 release，完成首次安装、plugin/skill 同步和 skill reload；网络层必须走生产实现，只把 origin 指向测试服务器。
2. scripted model 先调用 loader，再根据真实 instruction text 组装普通 Runtime Node/Python 命令；命令生成 PPTX 和 QA receipt。
3. 断言 loader tool item、command approval/item、artifact registration 和最终消息是同一 thread/turn 内的真实有序链，但各自使用真实 ID。
4. 推进 bundle version 验证 `current → outdated → installed`；坏 SHA/坏 archive/candidate broken 时旧 active 不变。
5. 从 legacy v2 cache 启动，分别验证通用 v2 candidate 失败时 legacy 仍为 active/可诊断，以及成功后新 active 生效且 legacy Runtime-owned desired-set 退出；用户 plugin 保留。
6. 在真实 installer 路径记录 archive/unpacked、空缓存冷安装、Main event-loop p99/max 和并发聊天结果；缺 budget、任一目标 budget 缺字段或超限时 E2E 必须失败。
7. 把 `primary-runtime-feed.e2e.ts`、Presentations runtime smoke、runner contract test 和 app-tools release verifier 中对私有包/旧 Presentations 的正向要求替换为已锁定授权 plugin、通用 v2、参考式 loader text 与普通 command item；保留 synthetic/legacy 拒绝用例，不允许通过删掉 release gate 过关。

验收证据至少包含 desktop commit、plugin upstream commit/source SHA、patch SHA、Runtime bundle/archive SHA、target、budget file/report SHA、engineering metadata/public-key SHA、loader output hash、command item/request ID、PPT/QA SHA 和 artifact source ID。P6 涉及的四类 test/gate 文件均不得再以私有包作为成功条件，也不得要求真实签名、trust receipt 或公开 CDN。

### P7：工程封板、GitHub artifact feed 与可选 live smoke

涉及：

- `desktop-app/tests/e2e/release-llm.e2e.ts` 的 R07
- `desktop-app/scripts/run-dev-llm-smoke.mjs`
- `desktop-app/scripts/run-release-llm-smoke.mjs`
- `desktop-app/scripts/verify-live-presentation-artifact.mjs`
- `desktop-app/scripts/tests/verify-live-presentation-artifact.node-test.mjs`
- `desktop-app/scripts/tests/release-workflow.node-test.mjs`
- `services/primary-runtime-feed/scripts/create-release-metadata.mjs`（新增 engineering metadata 生成器）
- `services/primary-runtime-feed/scripts/generate-engineering-signing-key.mjs`（新增，只写入 runner 临时目录）
- `services/primary-runtime-feed/scripts/sign-config.mjs`
- `services/primary-runtime-feed/scripts/sign-manifest.mjs`
- `services/primary-runtime-feed/scripts/assemble-release-staging.mjs`
- `services/primary-runtime-feed/scripts/publish-release.mjs`
- `services/primary-runtime-feed/package.json`
- `.github/workflows/primary-runtime-build.yml`
- `.github/workflows/primary-runtime-publish.yml`（迁移为 GitHub artifact revalidation/assembly，不写公开服务）
- `.github/workflows/desktop-release.yml`

工作项：

1. R07 固定 fixture 声明六个 `expectedPageTypes`：`cover`（封面）、`agenda`（议程）、`summary`（摘要）、`table`（数据表）、`chart`（数据图）和 `image`（图片）。deterministic scripted model 读取同一份非 PPTX 工作区输入，调用 loader，再按 plugin 技能和 loader paths 通过普通命令新建至少 6 页，每类至少一页；测试不提供既有 PPTX，也不声称支持编辑。fixture 为每类提供唯一的本地化标题 token，artifact verifier 必须逐项命中，不能只按 slide count 猜类型，也不能用一页同时顶替两类。
2. 验证 PPTX ZIP/relationships、slide count ≥ 6、六类标题 token、输入事实、表格行列、chart relationship、image relationship/alt text、中文字体、render、contact sheet、overflow/overlap、LibreOffice open 和右侧工作区预览。contact sheet 是 QA 输出，不算第七类页面。
3. dev 与 packaged deterministic R07 使用相同断言；packaged 测试从空 cache 经本次 run 生成的 engineering feed 安装，不使用用户 plugin cache、系统依赖或预生成文件。真实模型 live smoke 在凭据存在时运行并记录结果，但缺凭据、配额或外部服务不阻塞 `engineering_complete`，也不能替代 deterministic gate。
4. 四目标 Runtime archive 分别附 input/file manifest、provenance、SBOM/license、component smoke、platform validation 和 budget measurement。四个 staging 必须来自同一 commit、source/toolchain lock 和 builder contract，target 集合不多不少；任何 target 缺失都阻止 engineering feed 汇总。
5. 将 `.github/workflows/primary-runtime-build.yml` 实现为 `fast`、`calibrate` 与 `final` 三种模式。自动 `pull_request`/`push` 只执行 `fast` source/contract lane；scheduled nightly 默认执行 `calibrate`；人工 `workflow_dispatch` 可选择三种模式。`calibrate` 与 `final` 共享四目标原生 matrix；matrix 固定为 `macos-15-intel`/`darwin-x64`、`macos-15`/`darwin-arm64`、`windows-2025`/`win32-x64`、`ubuntu-24.04`/`linux-x64`，且 `fail-fast: false`。每个 target 先在 `build-target` 运行 fetch/materialize/verify/P1a 或 final build/platform/provenance，并上传固定名 `primary-runtime-<target>-build-artifacts`；随后独立同目标 `validate-target` 从本次 run 下载该 artifact，重新计算 archive SHA 后运行 P3a/P3b，生成 candidate 或 final staging。`calibrate` 保留 5 次 P1a build/unpack 和 10 次 P3b cold install/Main event-loop 证据，只上传固定名 candidate/measurement artifacts，不生成 feed；审查者据此以独立 commit 更新 budget。校准前先构建一次桌面测试宿主，P3b 仅可在检查过 main/preload/renderer 产物的显式开关下复用该 build。Windows 可缓存已验证输入目录，但 key 必须绑定 lock、脚本、patch 和精确 runner image，命中仍重跑 `verify:inputs`。`final` 模式要求已提交且绑定对应 measurement SHA 的 budget，重新从 clean checkout 执行 fetch/materialize/build/verify/performance-budget-check，并上传固定名 `primary-runtime-<target>-staging`。随后 `aggregate-engineering-feed` 只消费这个 final run 的四个固定 staging 并生成 `four-target-summary.json`。因此校准与 final 通常是两个 GitHub run；“同一 run”只约束四个 final staging 与其 feed 汇总，不能绕过独立 budget diff。
6. 协调 job 在 `$RUNNER_TEMP` 生成临时测试密钥，创建 `releaseClass=engineering` 的 config/manifest，执行正向验签及错误 key、payload 篡改、sequence 回退、非法 origin、target 缺失和 digest 不一致的负向测试；随后组装 `primary-runtime-engineering-feed`。上传内容只含公钥、签名 metadata、四目标不可变 archive/provenance/evidence 和汇总 receipt；私钥在 job 结束前删除且永不进入 cache/artifact/log。
7. 将 `.github/workflows/primary-runtime-publish.yml` 改为可选的 artifact revalidation/assembly 入口：只接收 `source_run_id`，按固定名称下载四目标 staging，验证 source commit/workflow identity/digests 后重新输出 GitHub artifact。删除自由填写 `metadata_artifact`/四目标名称的输入，删除生产 secret、origin 写权限、public deploy、canonical config 切换和 forward-recovery 要求。本轮不新增 `.github/workflows/primary-runtime-sign-metadata.yml` 或 `.github/workflows/primary-runtime-deploy.yml`。
8. engineering evidence 将 desktop commit/artifact SHA、source/toolchain/input/file manifest SHA、Runtime archive SHA、plugin source/patch SHA、platform-validation SHA、target budget 文件 SHA、实测 performance report SHA、engineering metadata/public-key SHA、GitHub run/artifact ID 和 PPT/QA/report SHA 串起来，并明确记录 `productionTrust=false`、`publiclyDeployable=false`。
9. 迁移 R07 prompt/assertion、live artifact verifier 及其单测、release workflow contract test、Primary Runtime build/publish workflow 和 Desktop release workflow；这些文件必须要求授权 plugin source lock、自动 input materialization、四目标原生验证、engineering metadata、六类新建页面、预算/性能 receipt 和 packaged preview，且不得再把私有包、旧 Presentations、真实签名、trust receipt 或公开 CDN 当作成功条件。

验收：四目标 Runtime 从 clean checkout 在固定 GitHub-hosted runner 上自动物化、构建和原生验证通过；协调 job 自动产生四个 target staging、四目标汇总 receipt 与 `primary-runtime-engineering-feed`，deterministic dev/packaged R07 都走 loader + 普通命令链生成可打开、包含六类页面且通过相同语义/结构/视觉断言的 PPTX。metadata 正向与篡改/回滚负向测试通过，artifact 不含临时私钥并明确不可公开部署。没有 Apple/Windows 生产签名、生产 trust receipt、真实 origin/CDN 或 live 模型凭据不阻塞工程封板。

## 6. Acceptance Criteria

1. `AC-01`：PPT plugin 是唯一有意替换项；P0 source lock 含候选的精确 tag、40 位 commit、source archive SHA256、patch SHA256 和逐项传递依赖许可证，且无 floating ref/placeholder；update、install、loader、plugin sync 和执行方式均有第 2 节参考证据对应。
2. `AC-02`：新 Runtime 使用通用 format v2；旧 `artifactToolVersion` v2 可读取/诊断/升级但不再进入新 feed。迁移测试证明 candidate 失败保留 legacy active，成功后 legacy Runtime-owned desired-set 退出且用户 plugin 保留。
3. `AC-03`：inline release/immutable manifest fallback、禁用时不访问 feed、启动检查、config/feature/connection generation 变化触发、hourly+jitter scheduled check、manual update、repair、cancel 和共享 in-flight 行为通过；`LATEST`/channel alias 不形成第二个权威入口。
4. `AC-04`：candidate 未完成 SHA、entry check、解压和 diagnostics 前 active 不变；激活失败旧 active 继续可用。
5. `AC-05`：按 target 分包且 v1 只接受 ZIP；下载流式写盘并报告可选 total bytes；坏 SHA、错误 target/format、越界 entry 和 ENOSPC 正确失败并清理 staging，tar/MSIX 不做隐式 fallback。
6. `AC-06`：P1a/P3a/P3b 顺序 gate 已创建并注册 `verify:budgets` 与 `test:primary-runtime:performance`，其 contract tests 通过；P1a hard-limit、四目标 build/unpack receipt、P3b cold-install/event-loop report 与 `runtime-budgets.json` 相互绑定。缺脚本、缺 package script、缺文件、缺目标、缺字段、错 candidate digest，或 archive/unpacked/minimum-free-disk/cold-install/event-loop 任一超限都 fail-closed；预算来自规定次数的 clean-runner 实测与独立 numeric diff 审查，并明确标为本项目加固而非参考项目参数。
7. `AC-07`：Runtime 激活后按参考顺序同步 marketplace、skills，并 force reload skill catalog；授权 PPT plugin 来自 active Runtime。sync/reload 失败不回滚已验证 active，但状态必须为 `runtimeActive=true, pluginReady=false, post_install_failed`，repair 后才可 ready。
8. `AC-08`：loader 只在 local + product feature + app-server `workspace_dependencies` feature enabled 时发布；Main 按 `{hostId, connectionGeneration}` 查询/分页/共享/缓存并在配置或连接变化时失效，查询异常 fail-closed。ready 仅返回参考字段集合的白名单绝对路径文本，missing/broken 返回稳定失败，不返回额外顶层 Runtime root、任意 adapter/archive/cache/feed 路径或 secret；命令仍受 sandbox/approval 约束。
9. `AC-09`：PPT 通过真实 app-server 普通 command path 执行；不存在新的 PPT 专用 Main dynamic tool 或第二套执行服务。
10. `AC-10`：plugin 和全部依赖离线、可追溯、满足分发条件；不读取模型 key，不直接访问模型/npm/PyPI/GitHub。
11. `AC-11`：关闭 MCP/Native Pipe 后，原生 loader tool call + command execution + artifact preview 仍通过。
12. `AC-12`：deterministic dev/packaged E2E 只 mock 外部模型 HTTP，Renderer/Preload/Main/app-server/tool/command/feed/installer/Runtime/archive/preview 均走生产代码；两套测试都从非 PPTX 输入新建并打开通过 QA 的 PPTX，包含封面、议程、摘要、数据表、数据图和图片六类独立页面。真实模型 live smoke 有凭据时运行，但不属于工程完成门禁。
13. `AC-13`：`macos-15-intel`、`macos-15`、`windows-2025`、`ubuntu-24.04` 分别生成 `darwin-x64`、`darwin-arm64`、`win32-x64`、`linux-x64` 真实 archive，并各自提供 native dependency load、LibreOffice/Poppler、锁定字体/render 和 clean-runner `platform-validation.json`。
14. `AC-14`：`codex/codex-rs/app-server/**` 无改动；Renderer 没有新增 Runtime 通用文件系统 API/secret surface，工具结果仅含 AC-08 白名单路径且日志脱敏；桌面无第二个 LLM client。
15. `AC-15`：P0 管辖的 synthetic 归档说明、ADR、feed spec、Primary Runtime/feed README、source lock、`source-lock.mjs` 和 source-lock 单测不再要求私有 OpenAI PPT 包或 `presentation-engine-v1`；旧名称只存在于 migration/negative test，本文是唯一生产执行真相源。
16. `AC-16`：产品声明、tool contract、测试输入和 release evidence 只覆盖“新建 PPTX + QA + 预览”，不包含任何既有 PPTX 编辑或 round-trip 验收。
17. `AC-17`：P5 的 host E2E、P6 的 engineering feed/smoke/app-tools gates、P7 的 R07/artifact/workflow 均已迁移到锁定授权 plugin、通用 v2、参考式 loader text、普通 command、六类新建页面和预算 receipt；全仓扫描确认私有包/旧 Presentations 只剩显式 legacy/synthetic/negative 引用，并确认真实签名、trust receipt、公开 CDN 不再是工程 gate。
18. `AC-18`：全新 checkout 的四目标 GitHub Actions 原生 runner 能从 source/toolchain lock 自动执行 `fetch → materialize → verify:inputs` 并生成 Runtime input root；工程候选构建显式传 `--input-root`。删除输入目录后可重建，不需要用户手工创建目录、系统 Node/Python/Office 或未绑定 CI artifact。
19. `AC-19`：source/toolchain lock 覆盖 Node/CPython runtime、每个 target 的 native binary 或完整源码构建配方、npm/Python 闭包和字体；input manifest 绑定每个文件 path/mode/SHA、builder/toolchain/patch/license，额外文件、错误目标和目录外依赖 fail-closed。
20. `AC-20`：四目标 staging 均含 file manifest、Runtime ZIP、SBOM/notices、provenance、component smoke、`platform-validation.json` 和 measurement receipt；`verify:platform` 在原生 runner 上真实执行，不再调用无条件阻塞的 `verify:platform-trust`。receipt 必须标记 `productionTrust=false`，且 workflow 不需要 Apple/Windows 生产签名凭据。
21. `AC-21`：首个预算按“P1a hard-limit 禁发候选与每目标 5 次 build/解压 → P3a 真实 installer → P3b 每目标至少 10 次冷安装/并发聊天/event-loop → calibration report → 独立人工审查预算 diff → 重建 release candidate”完成；workflow contract 拒绝跳步，同一 release job 不能生成或放宽预算。
22. `AC-22`：`aggregate-engineering-feed` 只消费同一 GitHub run/commit 的四个固定命名 target staging，生成 `four-target-summary.json` 和 `primary-runtime-engineering-feed`。CI 临时密钥覆盖 metadata 正向验签、错误 key、payload 篡改、sequence 回退、非法 origin、target 缺失和 digest 不一致；artifact 仅含公钥，扫描证明没有私钥、生产 secret 或云写凭据。
23. `AC-23`：消费端为每个安装暴露可关联的 call/operation ID、phase、failure stage/domain/category/code/retryable 和 safe/sensitive telemetry；not-installed 与 metadata-missing 可区分，只有网络/超时/5xx/408/429 类进入自动重试。
24. `AC-24`：本轮 workflow 的最远写操作是上传 GitHub Actions artifacts；`primary-runtime-publish.yml` 只接受 `source_run_id` 并重新验证/组装固定 artifact，不含 public origin/CDN 上传、canonical production config 切换、forward-recovery、生产签名 secret 或 `.github/workflows/primary-runtime-deploy.yml` 依赖。工程结果只能报告 `engineering_complete`，不能报告 `production_ready`。

## 7. Verification

### 7.1 参考证据与边界

```bash
npm --prefix desktop-app run reference:chatgpt:validate -- \
  --root /Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified

npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:real-codex-app-server-contract
npm --prefix desktop-app run verify:bundled-plugins
npm --prefix desktop-app run verify:app-tools-release-gates
```

### 7.2 Runtime producer/client

下列 `fetch:sources`、`materialize:inputs`、`verify:inputs`、`verify:platform`、`verify:hard-limits`、`test:primary-runtime:performance`、`generate:engineering-key`、`create:metadata`、`sign:config` 和 `sign:manifest` 是 P1a/P3a/P3b/P7 必须新增或迁移并在对应 `package.json` 注册的交付物。现有 `verify:platform-trust` 无条件阻塞占位必须删除，不能保留为 alias 或 required job。最终验证开始前，先由 package-script/workflow contract tests 证明名称、入口和 `P1a → P3a → P3b → budget review → final rebuild → engineering feed aggregate` 调用顺序存在；缺任一项直接判定计划未完成。

```bash
npm --prefix primary-runtime test
npm --prefix primary-runtime run fetch:sources -- --target=<native-target> --cache=<content-addressed-cache>
npm --prefix primary-runtime run materialize:inputs -- --target=<native-target> --source-cache=<content-addressed-cache> --output=<generated-input-root> --allow-source-build
npm --prefix primary-runtime run verify:inputs -- --target=<native-target> --input-root=<generated-input-root>
npm --prefix primary-runtime run verify:hard-limits
npm --prefix primary-runtime run build -- --target=<native-target> --input-root=<generated-input-root> --compression-level=6
npm --prefix primary-runtime run verify -- --target=<native-target>
npm --prefix primary-runtime run verify:platform -- --target=<native-target> --archive=<target-archive> --output=<platform-validation-receipt>
npm --prefix desktop-app run test:primary-runtime-real
npm --prefix desktop-app run test:primary-runtime:stress
npm --prefix desktop-app run test:primary-runtime:performance -- --candidate=<p1a-candidate-set> --output=<four-target-performance-measurements>
npm --prefix primary-runtime run calibrate:budgets -- --measurements=<four-target-measurements>
npm --prefix primary-runtime run verify:budgets
npm --prefix primary-runtime run build -- --target=<native-target> --input-root=<generated-input-root> --release-budget=<reviewed-budget-file> --compression-level=6
npm --prefix primary-runtime run verify -- --target=<native-target> --release-budget=<reviewed-budget-file> --performance-report=<reviewed-performance-report>
npm --prefix services/primary-runtime-feed run generate:engineering-key -- --output=<runner-temp-key-dir>
npm --prefix services/primary-runtime-feed run create:metadata -- --release-class=engineering --targets=<four-verified-targets> --output=<unsigned-metadata>
npm --prefix services/primary-runtime-feed run sign:config -- --key=<runner-temp-private-key> --input=<unsigned-config> --output=<signed-config>
npm --prefix services/primary-runtime-feed run sign:manifest -- --key=<runner-temp-private-key> --input=<unsigned-manifest> --output=<signed-manifest>
npm --prefix services/primary-runtime-feed test
npm --prefix services/primary-runtime-feed run assemble-release-staging -- --targets=<four-verified-targets> --metadata=<engineering-metadata> --output=<engineering-feed-staging>
npm --prefix services/primary-runtime-feed run publish-release -- --repository-root=<temporary-repository> --staged-root=<engineering-feed-staging>
npm --prefix desktop-app run smoke:presentation-skill-runtime
npm --prefix desktop-app run test:e2e:primary-runtime-feed
```

上述 `<native-target>` 命令由 `.github/workflows/primary-runtime-build.yml` 的四个对应 clean runner 分别执行；协调 job 只汇总四份 receipt，不把 `build:matrix` 当成本机一次性跨平台构建。第一次 build 只产生 P1a 禁发候选；performance report 和独立 budget diff 完成后，必须执行第二次 final build。`build-target` 与 `validate-target` 使用同一 target runner 类型：前者只产出经 platform/provenance 绑定的 build artifact，后者只消费本次 run 的该 artifact，并重新做 archive SHA、P3a/P3b 和 staging。交叉编译或当前机器的 `--matrix` 循环不能替代目标系统上的 native load/render 和冷安装证据。CI 可用 npm cache、内容寻址 source cache、精确 Windows runner image 绑定的 verified-input cache、压缩级别 6 和分段 build artifact 提速，但任何 cache/artifact 复用都必须重新走适用的 SHA/manifest/provenance/installer 校验。工程 metadata negative tests 必须证明少一个 target、混用 commit/source lock、预算超限、sequence 回退/溢出、非法 origin、错误 key 或 artifact digest 不一致时都不能产生 engineering feed；它们不检查生产证书、trust receipt、recovery target 或真实 CDN。

### 7.3 Desktop 全链

```bash
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app test
npm --prefix desktop-app run test:e2e -- --reporter=line
npm --prefix desktop-app run test:e2e:packaged
npm --prefix desktop-app run test:plan-coverage
```

以下是凭据存在时的非阻塞 live smoke；结果进入附加 evidence，但失败或 skip 不改变 `engineering_complete`：

```bash
npm --prefix desktop-app run test:e2e:dev-llm
npm --prefix desktop-app run test:e2e:release-llm
```

## 8. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 构建脚本要求一个没人生产的 `runtime-inputs/<target>` 目录 | GitHub Actions workflow 先从 source/toolchain lock 执行 fetch/materialize/verify，并显式传 `--input-root`；默认目录只允许单测 fixture，clean checkout 重建是 AC-18 |
| source lock 有源码 URL，但没有可执行解释器/原生工具的目标配方 | Node/CPython/native/fonts 必须锁 immutable binary，或锁 builder image/toolchain/flags/patch；每个目标通过 native format/version/load/render 验证 |
| 未做生产签名却被误认为可公开发布 | 所有 staging/feed/receipt 固定写入 `releaseClass=engineering`、`productionTrust=false`、`publiclyDeployable=false`；contract test 禁止出现 `production_ready` |
| CI 临时 metadata 私钥泄漏到 artifact/cache/log | 只在 `$RUNNER_TEMP` 生成，关闭 command echo，artifact allowlist 只接收公钥/签名输出；上传前递归扫描 PEM/private-key 标记，job 结束删除临时目录 |
| GitHub artifact 被误当成公开 CDN | workflow 权限只保留 `contents: read`/`actions: read`，不配置 cloud credential 或 deploy environment；artifact 名称固定为 `primary-runtime-engineering-feed`，README 明确仅供测试与后续生产交接 |
| GitHub-hosted runner 不能证明最低客户端 OS 的 Gatekeeper/SmartScreen 行为 | 本计划只声称四目标原生构建与执行；最低 OS、发布者信誉和真实安全提示由后续 Production Readiness 计划使用 self-hosted/专用 runner 验证 |
| 第一版预算来自猜测、阶段循环或同一 job 自动放宽 | P1a 只产 hard-limit 禁发候选；P3a installer 完成后由 P3b 实测，calibration 只出报告，预算由独立人工审查 diff 提交，再重建 release candidate |
| 把 MIT 根许可证当成全部依赖都可分发 | 对 npm、Python、native binary、字体逐项做 source lock、SBOM、notice 和目标平台审查；缺项即阻塞 engineering artifact 汇总 |
| plugin 可发现但依赖未 provision | bundle diagnostics 同时核验 plugin marketplace、解释器、modules、binaries 和字体；离线 clean-machine smoke |
| app-server feature 查询被多处缓存或连接重建后沿用旧值 | Main 单一所有者按 host/connection generation 缓存；配置或 generation 变化失效，错误 fail-closed；新/旧 thread snapshot 边界用 contract/E2E 固定 |
| 又把 plugin 包装成自创宿主执行服务 | contract test 断言 loader 后出现真实 command item，而不是第二个 PPT dynamic tool |
| legacy v2 兼容变成永久双轨 | 只保留读取/诊断/升级；新 feed 只发通用 v2，成功升级后旧包不在能力目录 |
| 大包下载导致卡顿、超时或磁盘写满 | target 分包、流式下载、可选 Content-Length 进度、取消、ENOSPC 分类、staging cleanup；四目标 numeric budget 对 archive/unpacked/free-disk/cold-install/event-loop fail-closed，且并发聊天 smoke 必须通过 |
| plugin sync/reload 失败但 UI 宣称 ready，或错误回滚已激活 Runtime | 区分 `runtimeActive` 与 `pluginReady`；post-install 失败保持 active、报告 `post_install_failed` 并 repair 重试，不伪造已加载 skill |
| 上游图片脚本绕过 app-server | patch 禁用直接模型 HTTP/API key；图片只走已发布的宿主 imagegen 能力 |
| 只在当前 Mac 成功 | 四目标 clean runner 执行 native module、LibreOffice/Poppler 和中文字体渲染 |

## 9. 尚需确认事项

本轮没有新的架构问题需要用户确认：产品范围固定为“新建 PPTX + QA + 预览”，执行方式和旧 v2 兼容方式已由参考项目证据定案。资源阈值按 P1a hard-limit 禁发候选 → P3a installer → P3b 四目标 GitHub clean-runner 基线 → 独立 numeric diff 审查 → final rebuild 生成，不要求现在凭经验拍数值。feature 状态固定由 Main 按 connection generation 管理。剩余的“source lock/逐项许可证机器校验”和“四平台实包及预算是否通过”属于工程证据；真实签名、信任回执、公开 CDN、生产 forward-recovery 和真实模型凭据明确不是本计划 blocker。

若后续要把复杂既有 PPTX 编辑纳入范围，需要另开 capability/parity 计划；它不阻塞本轮新建 PPTX + QA + 预览闭环。

后续若要从 `engineering_complete` 进入 `production_ready`，必须新建 Production Readiness 计划，单独定义 Apple/Windows 身份签名、生产 metadata key custody/rotation、平台信任回执、最低 OS 兼容、公开 origin/CDN、canonical promotion、forward-recovery 和上线监控；不得通过改名 GitHub artifact 或复用 CI 测试密钥完成该状态转换。

## 10. Stop Condition

只有 `AC-01` 至 `AC-24` 全部满足，四目标 Runtime 从 clean checkout 在固定 GitHub Actions 原生 runner 上自动完成输入物化、P1a 禁发候选、P3a installer、P3b 实测与独立预算审查、final rebuild、platform validation、engineering metadata 验签/篡改拒绝、GitHub artifact feed 汇总，且 deterministic dev/packaged R07 使用同一授权 plugin/source lock，通过 `load_workspace_dependencies → 普通 command execution → 六类新建 PPTX 页面/QA/preview` 生成可验证产物，才能宣告 `engineering_complete`。任何手工 Runtime 输入目录、来源不明的 metadata artifact、缺 target、私有 OpenAI PPT 包、用户全局 plugin、系统工具链作为 Runtime 内容、在线依赖安装、假工具调用、预生成 PPT 或既有 PPTX 编辑演示都不能作为替代证据。Apple/Windows 生产签名、生产信任回执、公开 origin/CDN、production metadata key 和真实模型 live smoke 不属于本 Stop Condition；同时本计划绝不允许宣告 `production_ready`。

## 11. 2026-09-12 参考复核记录

- 将 PPT 执行从自创 `presentation-engine-v1` 宿主能力改为参考项目的 loader + 普通命令链；Runtime shim 如存在也只是普通锁定脚本。
- 将新发布格式从“为引擎另造 v3”改为通用 format v2；旧 `artifactToolVersion` v2 仅保留读取/诊断/升级兼容。
- 将 rollback 收敛为 candidate/active 切换失败时保留旧 active；不把永久多版本回滚、plugin generation 或 thread admission barrier 当作参考复刻条件。
- 将 legacy-v2 兼容补成只读 decoder/diagnostics/desired-set，并增加迁移失败保留旧 active、成功退出 legacy desired-set 的双向测试。
- 将包体策略改为 target 分包、流式进度、SHA、entry 防越界、ENOSPC 和实包度量；参考 parity 不虚构数值，但本项目新增必须提交、可失败的四目标 archive/unpacked/free-disk/cold-install/event-loop budget。
- 修正“loader 被 Runtime readiness 过滤”的旧事实：当前实现已经在 Runtime 未就绪时发布 loader，但输出与 feature gating 仍需按参考契约调整。
- 明确 loader 的安全边界：允许参考字段中的白名单绝对路径，禁止额外 root/adapter/archive/cache/feed 信息；工具结果可能进入 journal，因此日志脱敏，命令仍走 sandbox/approval。
- 将 bundled plugin/skill 同步顺序固定为参考项目的 marketplace sync → skill sync/remove → `skills/list forceReload`。
- 增加“已存在/需保持、已存在/需迁移、未实现、外部证据阻塞”矩阵，避免把已有类、fixture 或测试入口再次写成待新增，也避免把局部存在写成整体完成。
- 将 synthetic 计划改为被取代的历史测试说明；工程执行唯一真相源是本文，不再以私有 OpenAI 包作为恢复条件。
- 将产品范围硬限定为“新建 PPTX + QA + 预览”，逐项排除既有 PPTX 的文本、图片、页面、主题和 round-trip 编辑。
- 依据第二轮独立审查，把 `siril9/presentation-skill` 从未定版本承诺改成 P0 阻断式候选锁定门；未写入不可变 commit/SHA/逐项许可证前不得进入构建。
- 将尚不存在的 `verify:hard-limits`、`verify:budgets` 与 `test:primary-runtime:performance` 明确为 P1a/P3b 的脚本、package entry 和 contract-test 交付物，消除“计划直接运行不存在命令”的歧义。
- 将 R07 固定为封面、议程、摘要、数据表、数据图、图片六类独立页面，并给出机器可断言的标题与结构。
- 将旧私有包/Presentations gate 迁移拆分到 P0 文档/source-lock、P5 host E2E、P6 feed/smoke/app-tools、P7 live/release workflow，并新增 AC-17 全仓扫描门禁。
- P0 候选审计结论：`v0.11.0`（commit `311e29920c7c7ab37a93c12676bab7baecc0f4a6`，archive SHA256 `b34fcadf960a157b838098608ba64c5e58e5e3c62b51924cb8e4944f199991f4`）因锁定的 `Pillow==12.3.0` 未在 PyPI 发布而标记 `candidate_rejected`。按本节第 5 步显式选择并锁定同一仓库的 `v0.8.0`（commit `a25708686160a13a4cdcb9cc1cc206fa9cb86219`，archive SHA256 `763827964186eeac53ee19d18055b640766ad840839cd35488c32fac9ed95fb7`，plugin tree SHA256 `9cb6bf30c6fa91e80aed59feece84119b63f81aa124f74d97ec871ce17c11fe4`）；本项目 patch 的 SHA256、最小调用闭包和逐项许可证均记录在 `primary-runtime/runtime-sources.lock.json`。此选择只授权“新建 PPTX + QA + 预览”allowlist；P1a 仍须构建并验证四目标实包，不得把 P0 审计记录误报为 release evidence。
- 补齐此前遗漏的生产端：现有 `build-runtime.mjs` 只读取已存在的 input root，而 build workflow 没有 materialize 步骤；P1a 现在明确 source/toolchain lock、内容寻址 fetch、GitHub Actions 四目标原生物化、input/file manifest、archive/provenance、platform validation 和目标 staging 的完整交接。
- 明确 Node/CPython runtime 与四目标 native binary 不能由 runner 预装环境补位；必须锁定 immutable binary，或提供 builder image/toolchain/flags/patch 的可审计构建配方。
- 将 feed 元数据生产收敛为同一 GitHub run 的 engineering aggregate job：临时测试密钥覆盖 config/manifest 验签与篡改/回滚拒绝，artifact 只含公钥并标记不可公开部署。
- 关闭真实签名、平台/发布信任回执和公开 origin/CDN 生产门禁；`primary-runtime-publish.yml` 只负责 GitHub artifact 复核/组装，本轮不新增 signing/deploy workflow，完成状态限定为 `engineering_complete`。
- 固定四平台 GitHub Actions runner 映射为 `macos-15-intel`、`macos-15`、`windows-2025`、`ubuntu-24.04`，并要求协调 job 只消费四个固定名 target staging。
- 修正预算启动顺序：拆成 P1a hard-limit 禁发候选与 build/unpack receipt → P3a 真实 installer → P3b cold-install/event-loop 实测 → 独立预算 diff → release rebuild，消除 P1 验收依赖 P3 runner 的循环。
- 依据参考源码补齐消费端的 inline/immutable-manifest 解析、disabled reason、共享 in-flight、串行队列、phase/stage、错误分类/retryable、diagnostics 区分和全窗口进度广播；参考 `LATEST.json` 仍保留为事实说明，但不成为本项目签名 feed 的第二权威指针。
- 明确参考项目等待 marketplace/skill 同步，但 `skills/list forceReload` 是 fire-and-forget；本项目保留“等待/重试 reload 才报告 plugin ready”作为显式可靠性加固，并规定 post-install 失败不回滚已激活 Runtime。
- 明确格式范围：参考项目支持 ZIP/tar/MSIX；本项目 feed v1 只发布/接受 target-specific ZIP，MSIX 以后另立 ADR。
- 依据参考 Main service 补清 feature gate 所有权：由 Main 通过 AI-free client 分页查询，按 host/connection generation 共享与缓存，配置或连接变化失效，查询异常 fail-closed；只影响新 thread capability snapshot。
- 修正最终 Presentations smoke 命令为仓库已注册的 `smoke:presentation-skill-runtime`。
