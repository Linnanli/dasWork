# Codex App Tools / Presentations 剩余缺口修复计划

日期：2026-09-07  
模式：`$plan` direct  
状态：可进入实施；本文件只定义修复与验收，不代表缺口已经完成  
来源：[Codex App Tools、Primary Runtime 与 Presentations 完整复刻计划](./codex-app-tools-primary-runtime-presentations-general-capability-plan.md)

## 1. 结论和目标

现阶段不能认定原计划完成。原计划仍明确标记为“实施中”，并把真实聊天 Presentations 证据、专用 Electron E2E、跨平台 Pipe 安全、跨平台安装后 smoke、分发授权、签名、可信发布源、大 Runtime 内存和激活空窗、全量 unit 超时列为未完成项，见[原计划状态](./codex-app-tools-primary-runtime-presentations-general-capability-plan.md#15-2026-09-07-实施审计状态)。

本计划的目标是把当前的“内部工程实施进行中”收敛为两个可以独立判断的结果：

1. **工程能力完成**：真实 renderer → main → Native driver → 真实 app-server → main registry 链路可重复验证；真实聊天能生成并展示 Presentations 产物；Runtime 在大包、并发切换和失败恢复下成立；默认全量 unit 门禁稳定为绿。
2. **公开发布完成**：macOS/Windows Pipe 身份边界、三平台安装后 smoke、clean-room 或书面授权、正式 Runtime feed、macOS/Windows 签名均通过；任何一项缺失都失败关闭。

这两个结果不能混记。工程能力完成不自动等于可公开发布。

## 2. 已确认的缺口和代码事实

### 2.1 真实聊天与完整桌面链路

- 原计划要求真实聊天出现 `load_workspace_dependencies`、command item 和最终 artifact 证据，但当前只交付了 deterministic Runtime smoke；原计划明确规定两者不能互相替代，见[验收 AC-24 至 AC-26](./codex-app-tools-primary-runtime-presentations-general-capability-plan.md#85-提示词与-presentations)和[测试矩阵说明](./codex-app-tools-primary-runtime-presentations-general-capability-plan.md#9-测试与验证矩阵)。
- 现有 live release suite 能启动真实安装包、删除 `CODEX_APP_SERVER_BIN`，并验证真实 `codex app-server --listen stdio://`，但工具断言仅检查是否出现任意 tool group，没有证明 `load_workspace_dependencies`、Presentations command 和 artifact 的因果链，见 [`release-llm.e2e.ts:226`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L226)、[`release-llm.e2e.ts:399`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L399) 和 [`release-llm.e2e.ts:408`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L408)。
- 生产主链已经把 capability snapshot 的 `dynamicTools` 和 `onDynamicToolCall` 交给 Native driver，见 [`codexChatRuntimeService.ts:810`](../../desktop-app/src/main/codexChatRuntimeService.ts#L810)；新 thread 通过 `thread/start.dynamicTools` 发布工具，见 [`NativeCodexRunDriver.ts:552`](../../desktop-app/src/main/codexRun/NativeCodexRunDriver.ts#L552)。缺的是不绕路的桌面验收，不是再造一条测试专用实现。
- 当前 Playwright 启动器可以启动开发版或安装后的可执行文件，并给每次运行隔离 `userData`/`CODEX_HOME`，见 [`support/app.ts:43`](../../desktop-app/tests/e2e/support/app.ts#L43)。这应作为新 E2E 的唯一应用启动入口。

### 2.2 现有 packaged app-tools smoke 不能证明生产链路

- [`run-packaged-app-tools-smoke.mjs:37`](../../desktop-app/scripts/run-packaged-app-tools-smoke.mjs#L37) 自己创建 Pipe，随后直接启动打包内的 `server.mjs`；[`run-packaged-app-tools-smoke.mjs:110`](../../desktop-app/scripts/run-packaged-app-tools-smoke.mjs#L110) 又在测试脚本中实现 `tools/list`/`tools/call` 响应。它能证明 launcher 和资源存在，但没有启动 Electron main、真实 app-server 或 `DynamicAppToolRegistry`。
- 现有安装介质 smoke 确实会挂载/安装/解包 DMG、NSIS、AppImage、deb、snap，再运行 Playwright，见 [`run-installer-local-media-smoke.mjs:21`](../../desktop-app/scripts/run-installer-local-media-smoke.mjs#L21) 和 [`run-installer-local-media-smoke.mjs:60`](../../desktop-app/scripts/run-installer-local-media-smoke.mjs#L60)；但其当前用例只覆盖 asar、本地媒体、终端、PDF 和 diff worker，见 [`packaged-local-media-smoke.e2e.ts:31`](../../desktop-app/tests/e2e/packaged-local-media-smoke.e2e.ts#L31)。

### 2.3 Pipe 平台安全

- Unix 当前只依赖临时目录 `0700` 和 socket `0600`，见 [`nativePipeServer.ts:65`](../../desktop-app/src/main/appTools/nativePipeServer.ts#L65) 和 [`nativePipeServer.ts:140`](../../desktop-app/src/main/appTools/nativePipeServer.ts#L140)；连接建立后直接进入 frame 处理，没有 peer PID/UID/进程世代校验，见 [`nativePipeServer.ts:167`](../../desktop-app/src/main/appTools/nativePipeServer.ts#L167)。
- Windows 当前显式失败关闭，见 [`nativePipeServer.ts:346`](../../desktop-app/src/main/appTools/nativePipeServer.ts#L346)。这是一条正确的临时安全边界，但也意味着 Windows 兼容链尚未交付。

### 2.4 Primary Runtime 内存和激活空窗

- release provider 按归档声明大小一次分配 `Uint8Array`，再把整个下载读入内存，见 [`PrimaryRuntimeReleaseProvider.ts:58`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L58)。
- installer 随后把整个 byte array 交给 `JSZip.loadAsync`，见 [`PrimaryRuntimeInstaller.ts:197`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L197)。即使单条目用 stream 写盘，压缩包和 ZIP 索引的生命周期仍与整个安装相连。
- 当前激活先把 `active` 重命名为临时 last-healthy，再把新目录重命名为 `active`，见 [`PrimaryRuntimeInstaller.ts:286`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L286)。两个 rename 之间存在可观察的 `active` 路径空窗；恢复逻辑也会先删除再重命名，见 [`PrimaryRuntimeInstaller.ts:147`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L147)。
- locator 仍把固定的 `cacheRoot/active` 当候选，见 [`PrimaryRuntimeLocator.ts:21`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeLocator.ts#L21)，因此不能只靠增加重试来掩盖空窗。

### 2.5 发布来源、签名与 bundle 授权

- `electron-builder.yml` 仍设置 `notarize: false`，且 `publish.url` 是 `example.com`，见 [`electron-builder.yml:35`](../../desktop-app/electron-builder.yml#L35) 和 [`electron-builder.yml:59`](../../desktop-app/electron-builder.yml#L59)。
- 当前 CI 的发布说明也明确声明 macOS 未 notarize、Windows 未签名，见 [`desktop-release.yml:274`](../../.github/workflows/desktop-release.yml#L274)。
- bundle lock 只记录参考版本、来源路径、复制时间和文件 SHA，没有分发授权或 clean-room provenance，见 [`bundle-lock.json:1`](../../desktop-app/resources/bundled-plugins/openai-bundled/bundle-lock.json#L1)；verifier 也只验证清单和 SHA，见 [`verify-bundled-plugins.mjs:14`](../../desktop-app/scripts/verify-bundled-plugins.mjs#L14)。
- Primary Runtime 当前只接受由环境变量同时提供的 URL、size、SHA 和 origin allowlist，见 [`runtimeConfig.ts:58`](../../desktop-app/src/main/runtimeConfig.ts#L58)。这适合显式配置，但还不是产品拥有、可轮换密钥验证、能抵抗旧版本回放的正式发布清单。

### 2.6 默认全量 unit 门禁

- 不稳定项仍完整断言 15 条 command、3 条 wait、分组数量和展开后的每条命令内容，见 [`App.test.tsx:5249`](../../desktop-app/src/renderer/src/App.test.tsx#L5249)。这些断言不能减量换绿。
- unit project 没有自定义 timeout，因此使用 Vitest 默认 5 秒；配置中的 30 秒只属于 `local-git-integration` project，见 [`vite.config.ts:17`](../../desktop-app/vite.config.ts#L17)。所以不能通过把 unit timeout 提到 30 秒来关闭缺口。

## 3. 不可违反的实施护栏

以下规则同时约束生产改动和测试改动：

1. 不修改 `codex/codex-rs/app-server/**` 或 `codex/codex-rs/core/**`；不把桌面聊天接回 provider package。
2. 确定性 Electron E2E 只允许在**外部模型 HTTP 边界**使用 scripted response。Renderer、preload、Electron main、`CodexChatRuntimeService`、`NativeCodexRunDriver`、AI-free client、真实 `codex app-server` 和 main registry 必须使用生产实现。
3. 验收 E2E 必须删除或显式置空 `CODEX_APP_SERVER_BIN`，不得把它设置为任何替身路径；不得伪造 `item/tool/call`，不得在测试脚本实现替代 registry/Pipe，也不得增加 test-only IPC、preload API 或 `window` 后门。
4. launcher contract、deterministic Runtime smoke、真实 app-server Electron E2E、live LLM smoke、安装后 packaged smoke 是五种不同证据；任何一项都不能代替另一项。
5. 不新增 `.skip`、`.only`、test-level retry、per-test/global timeout，不降低 command/wait 数量，不删失败场景或把必达断言改成日志/warning。真实外部服务 outage 只能按 P5-B 的规则触发一次整套重跑，并保留两次独立证据。
6. 不用轮询重试修补 Runtime `active` 空窗；修复必须改变激活模型，使读者只解析原子指针并进入不可变版本目录。
7. 不把 macOS/Linux 的 `0600` 或随机路径解释为 peer authentication；不把 Windows 当前用户“通常可用”的默认 ACL 当作显式 owner-only DACL。
8. release gate 必须验证**同一 commit、同一安装包 SHA**的签名、资源、运行证据；不能拿开发版结果替代安装包结果。

## 4. 执行顺序和依赖

```text
P0 证据契约与 unit 稳定性
 ├─ P1 真实 app-server 的确定性 Electron E2E
 ├─ P2 Runtime 流式安装 + 指针式激活
 └─ P3 Pipe 平台身份边界
        ↓
P4 clean-room/授权 + 正式 Runtime feed + 签名
        ↓
P5 三平台安装后 smoke + live Presentations
        ↓
P6 同一发布候选的最终封板
```

P1 可先用开发版 fixture Runtime验证主链。Windows packaged app-tools 依赖 P3；安装包中的 live Presentations 依赖 P2、正式 Runtime feed 和签名；公开发布依赖全部阶段。

## 5. 分阶段实施计划

### P0-A：建立不可伪造的验收清单

涉及文件：

- 新增 `desktop-app/tests/app-tools-release-gates.json`
- 新增 `desktop-app/scripts/verify-app-tools-release-gates.mjs`
- 新增 `desktop-app/scripts/tests/verify-app-tools-release-gates.node-test.mjs`
- 修改 [`package.json:11`](../../desktop-app/package.json#L11)
- 修改 [`desktop-test-plan.yml:84`](../../.github/workflows/desktop-test-plan.yml#L84) 和 [`desktop-release.yml:80`](../../.github/workflows/desktop-release.yml#L80)

步骤：

1. 为本计划建立稳定 ID：`AT-E2E-01`、`AT-LIVE-01`、`AT-LIVE-PKG-01`、`AT-PIPE-MAC-01`、`AT-PIPE-WIN-01`、`AT-PKG-MAC-01`、`AT-PKG-WIN-01`、`AT-PKG-LINUX-01`、`AT-RT-MEM-01`、`AT-RT-SWAP-01`、`AT-BUNDLE-01`、`AT-FEED-01`、`AT-SIGN-MAC-01`、`AT-SIGN-WIN-01`、`AT-UNIT-01`。
2. 每项声明 required layer、允许的 evidence producer、同 commit/asset SHA 约束和初始 `pending`。状态只有在 verifier 能读取实际测试报告/签名报告/产物摘要时才能变为 covered；不能手改布尔值宣称完成。
3. release workflow 在任一必达 ID 缺证据、证据 commit 不同、安装包 SHA 不同或报告过期时失败；PR workflow 只要求本次变更涉及的工程 gate，不要求访问生产签名密钥。
4. 保留原 `tests/test-plan-coverage.json` 的对话测试职责，不把新 release gate 硬塞进不相干的 A01-G12 契约。

验收：

- verifier 自测覆盖缺文件、伪造 `covered`、错误 commit、错误 artifact SHA、重复证据和已过期证据；六种情况全部失败。
- 工作流上传的是脱敏后的 JSON、Playwright trace、截图和签名校验摘要；不得上传 token、模型请求正文、完整环境变量或 Runtime 下载凭据。

### P0-B：定位并消除 `App.test.tsx` 全量负载超时

涉及文件：

- 修改 [`App.test.tsx:1255`](../../desktop-app/src/renderer/src/App.test.tsx#L1255) 的 fixture 清理，保留 [`App.test.tsx:5249`](../../desktop-app/src/renderer/src/App.test.tsx#L5249) 的完整场景
- 若证据指向生产热点，修改 [`assistantRenderUnits.ts:1895`](../../desktop-app/src/renderer/src/lib/assistantRenderUnits.ts#L1895)、[`toolGroupSummary.ts:534`](../../desktop-app/src/renderer/src/lib/toolGroupSummary.ts#L534) 或对应 render unit 组件；不得先改 timeout
- 新增 `desktop-app/scripts/run-app-unit-stability.mjs`
- 修改 [`package.json:14`](../../desktop-app/package.json#L14)

步骤：

1. 在未改 timeout 的基线上记录目标测试单独运行、`App.test.tsx` 全文件运行、全量 `test:unit` 运行的耗时、堆增量、DOM 节点数和未清理 timer/listener 数。
2. 检查 hoisted mock 的调用历史、React root 卸载后的异步工作、Radix 展开动画和全局 stub 是否跨 test 累积。先修 fixture 生命周期；只有 profiling 证明真实渲染算法随历史条目非线性增长时，才改生产 grouping/render 逻辑。
3. 保持 15 条 command、3 条 wait、三个 command group、所有展开内容和历史最终文本断言不变。允许把重复查询提取为 helper，但不允许拆成更小数据集后删掉原压力场景。
4. 增加稳定性脚本：目标 test 新进程重复 50 次，整个 `App.test.tsx` 重复 10 次，全量 `test:unit` 连续 3 次；任一非零退出立即失败。

验收：

- `AT-UNIT-01`：上述 50/10/3 轮均通过，目标 test 每轮低于默认 5 秒；没有 timeout/retry/skip 变化，场景数据量和断言语义不减少。
- 若最终只改测试 fixture，报告必须证明泄漏来自测试生命周期；若改生产代码，新增性能回归测试必须证明 15/50/100 个历史 tool item 的构建时间近似线性且 UI 输出不变。

### P1：交付 renderer → real app-server → registry 的确定性 Electron E2E

涉及文件：

- 新增 `desktop-app/tests/e2e/app-tools-host.e2e.ts`
- 修改 [`mockBackend.ts:145`](../../desktop-app/tests/e2e/support/mockBackend.ts#L145)，只新增标准 Responses API 的 dynamic function-call scripted step 和请求结果读取 helper
- 复用 [`support/app.ts:43`](../../desktop-app/tests/e2e/support/app.ts#L43) 与 `tests/e2e/support/chatActions.ts`
- 必要时仅为可访问性 selector 补 `data-slot`；不得新增测试 IPC

用例一：`AT-E2E-01`，新 thread 的 `load_workspace_dependencies` 完整穿透。

1. 创建最小健康 Runtime fixture，并通过现有 development locator 配置给应用；启动前显式删除 `CODEX_APP_SERVER_BIN`。
2. scripted model 的第一轮只返回 `codex_app.load_workspace_dependencies` function call；第二轮只在收到工具结果后返回最终文本。scripted provider 不得直接返回伪造的 dependency result。
3. 从 provider 捕获的第一轮请求断言 app-server 实际向模型发布了 `codex_app` namespace 和工具 schema；从第二轮请求断言同一 call ID 的 function output 包含 fixture Runtime 的规范化路径。
4. 从 UI 断言 dynamic tool 的 input、完成状态和最终文本；从应用状态断言运行的是普通 `codex app-server --listen stdio://`。
5. 关闭应用后断言 thread/turn/call ID 一致、无遗留 app-server/MCP/Pipe 进程和 socket。

用例二：resume 边界。

1. 创建旧 thread 后改变 Runtime/工具目录，再 resume。
2. 断言 resume 不伪造 `dynamicTools` 或 MCP config；只有新 thread 使用新 capability revision。这锁定 [`NativeCodexRunDriver.ts:569`](../../desktop-app/src/main/codexRun/NativeCodexRunDriver.ts#L569) 的协议边界。

验收：

- `AT-E2E-01` 只有在真实 app-server 进程、真实 main registry 输出、provider 的 function output 和 UI tool item 四份证据使用同一 call ID 时通过。
- 测试源码静态检查拒绝给 `CODEX_APP_SERVER_BIN` 赋替身路径、自建 `net.createServer`、fake registry、直接调用 `hostCapabilities.dispatch` 和 test-only bridge；允许且要求删除/置空该环境变量。

### P2-A：把 Runtime 下载和 ZIP 解压改为有界内存

涉及文件：

- 修改 [`PrimaryRuntimeReleaseProvider.ts:3`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L3)
- 修改 [`PrimaryRuntimeInstaller.ts:55`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L55)
- 修改 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.test.ts`
- 修改 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.test.ts`
- 新增 `desktop-app/scripts/run-primary-runtime-install-stress.mjs`
- 修改 [`package.json:52`](../../desktop-app/package.json#L52)

决定：

- provider 不再返回 `Uint8Array`；它把响应流写入 installer 创建的 `.part` 文件，同时增量计算 SHA-256、累计 size、响应取消、`fsync`，校验成功后原子改名为只读 archive 文件。
- ZIP 解压使用从文件按 entry 懒读取的实现，不把整个压缩包装入 JS heap。由于 Node 标准库没有 ZIP reader，实施前必须对候选库做依赖审查并取得“新增直接依赖”批准；优先评估已在 lockfile 中作为传递依赖出现、支持 lazy entry/file descriptor 的实现，但生产必须直接锁版本，不能依赖传递安装结果。
- 路径穿越、symlink、entry 数、单项/总解压大小、磁盘余量、可执行位和取消规则保持或加强，不能因更换解压器而弱化 [`PrimaryRuntimeInstaller.ts:205`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L205) 至 [`PrimaryRuntimeInstaller.ts:242`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L242) 的安全语义。

验收：

- `AT-RT-MEM-01`：以正式 Runtime 当前量级的真实归档运行安装；基线采样后，主进程最大 RSS 增量不超过 384 MiB，且不出现与归档大小同量级的单次 ArrayBuffer/Buffer 分配。
- CI 快速门使用至少 512 MiB 的流式生成 ZIP；protected release 门使用实际候选 Runtime 归档。小 fixture 只能证明安全语义，不能关闭大包内存项。
- 截断、超长、SHA 错、取消、磁盘不足和恶意 entry 均不改变 active pointer，`.part`/staging 最终清理；日志只含版本、字节数和摘要，不含签名密钥或 URL credential。

### P2-B：用不可变版本目录和原子指针消除激活空窗

涉及文件：

- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivePointer.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivePointer.test.ts`
- 修改 [`PrimaryRuntimeInstaller.ts:84`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L84)
- 修改 [`PrimaryRuntimeLocator.ts:18`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeLocator.ts#L18)
- 修改 [`PrimaryRuntimeService.ts:52`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts#L52)

目标布局：

```text
primary-runtime/
  versions/<bundleVersion>-<archiveSha256>/...
  active.json
  active.json.next
  downloads/<archiveSha256>.zip
  .staging-*/...
```

步骤：

1. 新版本完整解压、诊断、只读化后移动到不可变 `versions/<version>-<sha>`；旧版本不改名、不删除。
2. `active.json.next` 只记录受约束的相对 version directory、bundle version、manifest SHA 和 generation。写入、flush 后用单次同目录 rename 替换 `active.json`。
3. locator 每次读取一份完整指针快照，校验路径仍在 `versions/` 内，再 realpath/diagnose。读者只能观察旧指针或新指针，不解析 `active/` 目录。
4. 首次升级时迁移现有 `active/`：先把健康目录放入 `versions/` 并写 pointer，确认新 locator 可读后才删除旧别名。崩溃恢复以最后一个合法 pointer 为准，忽略/清理 `.next`。
5. 保留当前版本和至少两个上一健康版本。GC 只删除既不是 active、也没有进程内 lease、且超过保留期的不可变目录；第一版可以只报告可回收项而不自动删除，避免为节省磁盘引入读者悬空。

验收：

- `AT-RT-SWAP-01`：在 macOS、Windows、Linux 上各执行至少 100 次激活，同时 32 个读者循环调用 locate/diagnose/load；零次 `missing`、`ENOENT` 或半新半旧路径，所有结果都完整属于旧 generation 或新 generation。
- 在 pointer 写入前、flush 后、rename 前后和 GC 前后注入崩溃；重启只能恢复旧健康版或新健康版，不能进入 broken/missing。
- 禁止用 locator retry 隐藏失败；压力测试把任何瞬时失败计为用例失败。

### P3：交付可认证的跨平台 App Tools IPC

涉及文件：

- 新增 `docs/adr/2026-09-07-app-tools-authenticated-local-ipc.md`
- 拆分 [`nativePipeServer.ts:51`](../../desktop-app/src/main/appTools/nativePipeServer.ts#L51) 为平台 transport 与纯 frame/session dispatcher
- 修改 `desktop-app/src/main/appTools/nativePipeServer.test.ts`
- 修改 [`DesktopThreadConfigSource.ts:20`](../../desktop-app/src/main/appTools/DesktopThreadConfigSource.ts#L20)
- 修改 host connection/process transport，使 main 能获得当前 app-server generation 的 PID/进程身份；不得改 app-server 源码
- 按 ADR 结果新增窄 native authorizer 或本地 broker，并纳入 `electron-builder` 打包/签名

先做一个有退出条件的两平台原型，不在未知 API 上直接堆补丁：

1. macOS 原型必须用受支持的 OS API取得 Unix peer UID/PID，并证明可把 peer PID 绑定到 main 启动的当前 app-server generation 及其 MCP 子进程；不得读取 Node 私有 `_handle`。
2. Windows 原型必须在 `CreateNamedPipe` 时应用 owner-only DACL，禁用 remote client，并取得 client PID/token SID；不能在 listen 后补 ACL，避免抢连窗口。
3. 若 Node/N-API 无法在不依赖私有 handle 的前提下同时满足两平台，采用 main 启动的窄 native broker：broker 拥有 socket/named pipe、做 OS 身份校验，只把已认证的 length-prefixed frame 转给 main；业务工具、context 校验和 registry 仍留在 TypeScript main。
4. 每个 Host connection generation 只授权它实际派生的 MCP 进程树；generation 结束立即撤销授权、关闭 client、abort pending call、删除端点。
5. `CODEX_APP_TOOLS_PIPE_PATH` 仍只能由 main 写入 thread config；增加每 generation challenge，challenge 只作为第二因子，不能替代 UID/SID/PID/ancestry 校验。

验收：

- `AT-PIPE-MAC-01`：正确 UID 但错误 PID/ancestry、旧 generation、抢先连接、重放 challenge、未签名/错误 executable identity 全部拒绝；真实 MCP client list/call/cancel 通过。
- `AT-PIPE-WIN-01`：其他本地用户、匿名/网络 client、错误 SID、错误 PID/ancestry、旧 generation 全部在业务 frame 前被拒绝；当前用户的正确 MCP client 通过。
- Linux 至少验证 `SO_PEERCRED` UID/PID、端点 `0700/0600`、旧 generation 和退出清理。Linux 不是以现有 mode bit 自动视为完整 peer auth。
- native 产物必须跟随应用签名；authorizer/broker 缺失或加载失败时 MCP 兼容链失败关闭，原生 dynamic tool 主链仍可独立工作并显示 degraded。

### P4-A：移除 proprietary bundle 的发布不确定性

首选路线是 clean-room bridge；书面分发授权只是可替代路线，二者满足其一即可，但不能没有证据就发布。

涉及文件：

- 新增 `docs/specs/codex-app-tools-bridge-protocol.md`
- 新增 repo-owned MCP stdio bridge 与单独的来源说明/许可证
- 修改 [`bundle-lock.json:1`](../../desktop-app/resources/bundled-plugins/openai-bundled/bundle-lock.json#L1) schema、descriptor parser 和 verifier
- 修改 `desktop-app/scripts/sync-codex-app-tools-bundle.mjs`
- 修改 `desktop-app/src/main/bundledPlugins/BundledPluginDescriptors.ts`

clean-room 路线：

1. Reviewer 只从本项目 Native Pipe protocol、MCP 标准行为和黑盒兼容测试写协议规格；实现者不阅读/复制 proprietary `server.mjs`。
2. 新 bridge 只实现 initialize、notifications/initialized、tools/list、tools/call、cancel/shutdown、错误/size/cancel 语义，不引入另一个工具 registry。
3. public resources 切换到 repo-owned bridge，迁移已安装的旧 internal plugin；public bundle verifier 明确拒绝已知 proprietary `server.mjs` SHA 和 `reference-projects` 来源路径。
4. 若选择授权路线，必须有可审计的书面 distribution grant、适用版本/SHA、允许渠道和到期/复审日期；lock 只记录 grant ID/摘要，不提交合同正文或敏感文件。CI 从受保护环境验证签名后的授权声明。

验收：

- `AT-BUNDLE-01`：public artifact 中每个 bundle 文件都能落到 repo-owned source+license，或落到有效的授权声明；缺任一 provenance 字段、授权过期、SHA 不符、出现额外文件均失败。
- clean-room bridge 必须通过现有兼容测试和新的真实 packaged main/Pipe 测试；不能用原 proprietary server 作为 golden implementation 跑在 release gate 内。

### P4-B：正式 Primary Runtime feed 和应用发布来源

涉及文件：

- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseManifest.ts`
- 修改 [`runtimeConfig.ts:1`](../../desktop-app/src/main/runtimeConfig.ts#L1)
- 修改 [`PrimaryRuntimeReleaseProvider.ts:16`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L16)
- 修改 [`electron-builder.yml:59`](../../desktop-app/electron-builder.yml#L59)
- 修改 [`desktop-release.yml:247`](../../.github/workflows/desktop-release.yml#L247)

步骤：

1. 产品拥有的 HTTPS endpoint 发布签名 manifest；manifest 包含 schema version、sequence、channel、platform、arch、bundle version、archive URL、size、SHA-256、issued/expiry、key ID。
2. main 内置可轮换的 Ed25519 public key 集合，用 Node `crypto.verify` 校验 canonical manifest；拒绝未知 key、过期、未来时间、sequence 回退、platform/arch 不匹配、跨 origin redirect 和 archive 摘要不符。
3. 现有五项环境变量配置保留给 development/test/显式 enterprise override；public packaged 默认必须走签名 manifest，renderer 仍不能指定 URL/root/key。
4. 当前没有 auto-updater 生产实现，因此删除误导性的 `example.com` publish block。第一阶段把 GitHub Releases/产品下载站定义为正式、带签名和 checksum 的人工下载来源；自动更新若要启用，另立功能计划，不能仅换 URL 就宣称完成。

验收：

- `AT-FEED-01`：有效 manifest 安装成功；正文改 1 byte、未知 key、过期、回滚、错误平台、redirect、archive size/SHA 错误全部失败且继续使用旧 Runtime。
- public package 中不存在 `example.com` feed；release notes、下载页和 checksum/signature 指向同一 artifact SHA。

### P4-C：macOS / Windows 签名与发布工作流

涉及文件：

- 修改 [`electron-builder.yml:28`](../../desktop-app/electron-builder.yml#L28)
- 修改 [`desktop-release.yml:134`](../../.github/workflows/desktop-release.yml#L134)
- 修改 [`verify-release-assets.mjs:1`](../../desktop-app/scripts/verify-release-assets.mjs#L1) 和 release contract tests

步骤：

1. 把当前 main push prerelease 与 public release 分开。PR/main 可以产出不公开的测试 artifact；只有受保护的 tag/environment、签名凭据和全部 gate 都满足时才运行 public publish。
2. macOS 对 app、native IPC 组件和 DMG 完整签名、hardened runtime、notarize、staple；Windows 对 exe/installer/native IPC 组件做 Authenticode timestamped signing。
3. release job 在发布前执行本机系统校验：macOS `codesign --verify --deep --strict`、`spctl --assess`、`xcrun stapler validate`；Windows `Get-AuthenticodeSignature`/`signtool verify /pa /all`。只看 electron-builder 成功日志不算证据。
4. checksum manifest 继续保留，并增加签名验证摘要、commit、builder version、依赖 lock SHA 和 SBOM/provenance attestation。

验收：

- `AT-SIGN-MAC-01`、`AT-SIGN-WIN-01` 必须针对最终将发布的 installer SHA；签名缺失、证书过期、timestamp 缺失、notarization/staple 失败或 native 子产物未签名均阻止 publish。
- 工作流不得把凭据传给 PR/fork job，不得在日志或 artifact 中保存证书密码/API private key。

### P5-A：把 packaged smoke 升级为真实安装后主链

涉及文件：

- 将 [`run-packaged-app-tools-smoke.mjs:15`](../../desktop-app/scripts/run-packaged-app-tools-smoke.mjs#L15) 重命名为 `run-packaged-app-tools-launcher-contract.mjs`，保留其“资源+launcher”窄职责
- 新增 `desktop-app/tests/e2e/packaged-app-tools-host.e2e.ts`
- 修改 [`run-installer-local-media-smoke.mjs:21`](../../desktop-app/scripts/run-installer-local-media-smoke.mjs#L21)
- 修改 [`desktop-release.yml:206`](../../.github/workflows/desktop-release.yml#L206)

步骤：

1. 在 macOS x64/arm64、Windows x64、Linux AppImage/deb/snap 的原生 runner 上安装/挂载/解包实际 artifact，使用其 packaged executable 启动完整应用。
2. 使用 scripted model 只在模型边界请求 `read_thread_terminal`；先从 UI 启动真实 packaged terminal，再让真实 app-server 发 `item/tool/call`，断言 registry 返回同一终端的脱敏标记。
3. 同一用例验证 clean-room MCP server 通过已认证 Pipe 对同一 registry 做 list/call/cancel，退出后端点、broker/native helper 和 app-server 全部清理。
4. Linux 三种格式都至少做启动/资源/签名或 checksum/IPC 清理；完整交互可在 AppImage 执行，deb/snap 不得只验证文件存在。

验收：

- `AT-PKG-MAC-01`、`AT-PKG-WIN-01`、`AT-PKG-LINUX-01` 的报告包含 OS/arch、commit、installer SHA、app packaged 状态、app-server version、thread/turn/call ID、registry output 摘要和退出清理结果。
- 自建 Pipe 的 launcher contract 仍有价值，但它不再被命名或计数为 packaged app-tools 主链证据。

### P5-B：真实聊天 Presentations 与 artifact 证据

涉及文件：

- 在 [`release-llm.e2e.ts:19`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L19) 增加独立 `R07/AT-LIVE-01` 场景，或新增 `tests/e2e/presentations-live.e2e.ts` 后由同一 runner 调用
- 修改 [`run-dev-llm-smoke.mjs:6`](../../desktop-app/scripts/run-dev-llm-smoke.mjs#L6) 和 [`run-release-llm-smoke.mjs:8`](../../desktop-app/scripts/run-release-llm-smoke.mjs#L8)，保持 opt-in 和真实模型边界
- 复用 deterministic [`run-presentations-runtime-smoke.mjs`](../../desktop-app/scripts/run-presentations-runtime-smoke.mjs) 只做产物复核，不把它计作 live chat

步骤：

1. 为每次运行创建空项目，发送明确但不注入工具结果的任务：“使用 Presentations skill 生成指定标题和两页内容的 PPTX，并完成 render/overflow 验证”。
2. 从现有 app-server debug/Playwright 诊断中生成**脱敏事件时间线**；只保留 event type、thread/turn/item/call ID、工具名、命令 executable 的规范化类别、artifact 相对路径和 SHA，不保存 prompt、模型正文、环境或凭据。
3. 依次断言：skill 被发现；`codex_app.load_workspace_dependencies` dynamic tool 完成；后续 command item 使用该结果中的 Runtime Node 和 `@oai/artifact-tool`，没有系统 `node`/`npx`/在线安装 fallback；最终出现 `.pptx` end-resource card；卡片能打开现有 presentation panel；文件结构、渲染页数和 overflow checker 通过。
4. 先交付 development live gate `AT-LIVE-01`；P4/P5-A 完成后，用最终签名安装包和正式 Runtime feed 运行 `AT-LIVE-PKG-01`。两者不能共用一份旧 evidence。

验收：

- 事件时间线中 `load_workspace_dependencies call → tool result → command started/completed → artifact resource → turn completed` 使用同一 thread/turn，顺序严格成立。
- PPTX 的 SHA、相对路径、UI artifact card 和离线结构/渲染复核相互一致；只生成文件但没有 UI artifact event，或只有 UI 卡片但文件无效，均失败。
- live gate 不允许 scripted model、provider fixture 或全用例自动 retry。允许 release runner 对已分类的外部服务 outage 做最多一次整套重跑，但两次 evidence 必须分开，不能拼接通过。

### P6：同一发布候选封板

1. 在干净 checkout 上锁定 commit、依赖 lock 和 Primary Runtime manifest sequence。
2. 依次运行静态边界、lint/typecheck、全量 unit 稳定性、确定性 real-app-server E2E、Runtime stress、三平台 build/install smoke、签名验证和 packaged live Presentations。
3. `verify-app-tools-release-gates` 聚合报告，要求所有必达 ID 的 commit 与 artifact SHA 一致。
4. 只有聚合报告全绿，才把原计划状态改为“里程碑 D 完成 / 可公开发布”；此前原计划必须继续保留“实施中”或更精确的分项状态。

## 6. 可测试验收标准总表

| ID | 必须证明 | 失败条件 |
| --- | --- | --- |
| `AT-UNIT-01` | 50 次目标、10 次 App 文件、3 次全量 unit，默认 5 秒规则 | timeout/retry/skip 增加，断言/数据量减少，任一失败 |
| `AT-E2E-01` | renderer → main → Native driver → real app-server → registry → UI | app-server 替身、直接 dispatch、自建 Pipe、call ID 断链 |
| `AT-RT-MEM-01` | 正式量级 Runtime 安装 RSS 增量 ≤ 384 MiB | 全包 Buffer/ArrayBuffer、只跑小 fixture、active 被错误替换 |
| `AT-RT-SWAP-01` | 100 次 swap × 32 readers 零瞬时失败 | retry 后通过、任何 missing/ENOENT/混合 generation |
| `AT-PIPE-MAC-01` | UID/PID/ancestry/generation 鉴权和负例 | 只检查 mode bit/challenge、旧 generation 可连 |
| `AT-PIPE-WIN-01` | 创建时 owner-only DACL + SID/PID/ancestry | listen 后补 ACL、其他用户可发业务 frame |
| `AT-BUNDLE-01` | clean-room provenance 或有效书面授权 | 只有 SHA/sourcePath、授权过期、公开包含未知来源文件 |
| `AT-FEED-01` | 签名 manifest、防回滚、正确 archive | placeholder、未知/过期 key、错误平台/摘要仍安装 |
| `AT-PKG-*` | 三平台实际 installer 启动完整主链和清理 | 只解包查文件、只跑 server.mjs、自建 registry/Pipe |
| `AT-LIVE-01` | 开发版真实模型 Presentations 事件因果链 | deterministic/scripted 代替、缺 tool/command/artifact 任一项 |
| `AT-LIVE-PKG-01` | 最终签名安装包 + 正式 Runtime feed 的同链证据 | 使用开发 root、旧 artifact/evidence、installer SHA 不一致 |
| `AT-SIGN-*` | 最终 macOS/Windows installer 和 native 子产物签名有效 | 未 notarize/staple、无 timestamp、只验证外层 installer |

## 7. 验证命令

实施后至少提供以下新入口；名称可微调，但职责不能合并：

```text
npm --prefix desktop-app run verify:app-tools-release-gates
npm --prefix desktop-app run test:unit
npm --prefix desktop-app run test:unit:app-stability
npm --prefix desktop-app run test:e2e -- tests/e2e/app-tools-host.e2e.ts --reporter=line
npm --prefix desktop-app run test:primary-runtime:stress
npm --prefix desktop-app run test:e2e:installer
npm --prefix desktop-app run test:e2e:presentations-live
npm --prefix desktop-app run test:e2e:presentations-live-packaged
```

最终封板仍必须同时运行现有入口：

```text
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:real-codex-app-server-contract
npm --prefix desktop-app run verify:bundled-plugins
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run test
npm --prefix desktop-app run test:e2e -- --reporter=line
```

## 8. 风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| peer PID/ACL 依赖私有 Node handle | Electron/Node 升级即失效，产生安全空窗 | 原型必须用支持的 OS API；不满足则转窄 native broker；失败关闭 |
| ZIP reader 依赖选择不当 | 路径穿越、zip bomb、维护风险 | 先做依赖/许可证/安全审查，直接锁版本；保留所有解压负例和正式大包压力门 |
| RSS 阈值受 runner 噪声影响 | 偶发失败或阈值失真 | 单独子进程、固定 fixture、记录 baseline 和 max RSS；protected runner 用正式包复核，不调高阈值掩盖 |
| 指针 GC 删除仍在使用的版本 | 已返回路径失效 | 不可变目录、generation lease、保守保留；第一版宁可不自动 GC |
| live LLM 非确定性 | 偶发不调用 skill/tool | 明确任务、固定模型/effort、完整事件证据；外部 outage 与行为失败分开分类，不用 scripted 结果补齐 live 证据 |
| clean-room 边界不清 | 新实现仍有版权风险 | 规格/实现人员分离、只用公开协议和黑盒测试、保存 provenance review；有疑问时停止 public bundle |
| 签名密钥不可用 | 无法公开发布 | 工程 gate 可继续，public publish 保持阻塞；不降级为发布后提示用户忽略系统警告 |
| 测试为了稳定而弱化 | 客户端真实 bug 被掩盖 | 护栏静态检查、相同数据量和断言、三种负载重复、review 必须同时看生产 diff 和测试 diff |

## 9. 完成与停止条件

只有同时满足以下条件才可关闭本计划：

1. `AT-*` 全部在同一 release candidate commit 上为绿；`AT-PKG-*`、`AT-LIVE-PKG-01`、`AT-SIGN-*` 指向同一组最终 installer SHA。
2. 默认全量 unit 连续 3 次为绿，没有 timeout/retry/skip 或断言弱化。
3. deterministic、live、packaged 三类报告分别存在，且没有用 fixture 或 launcher contract 代替生产链路。
4. Runtime 正式量级内存门和并发无空窗门通过；任何一次瞬时 missing 都算失败。
5. public bundle 有 clean-room provenance 或有效授权；正式 Runtime feed、macOS notarization、Windows Authenticode 和三平台安装后 smoke 全部通过。
6. `git diff` 证明未修改 Codex app-server/core，未把 provider 接回生产聊天，未增加 renderer 的任意 Node/MCP/Runtime 权限。
7. 原计划第 15 节按证据更新，未完成项清零；若签名凭据、书面授权或正式 feed 尚未由外部组织提供，只能把本计划标成“工程完成，公开发布受阻”，不能标成全部完成。
