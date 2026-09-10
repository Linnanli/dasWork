# Primary Runtime 参考架构复刻与真实 Presentations 闭环计划

日期：2026-09-09

模式：`$plan` direct

状态：已补充独立审查提出的阻断项；待复审通过后进入实施，本文件不代表功能已完成

取代范围：本计划取代旧计划中“仅补剩余缺口”的执行口径，保留已经完成且通过复核的底层实现，不接受以局部接线宣告整体完成

## 1. 结论

采用参考项目证据已经证明的主分发路径：**Primary Runtime 由产品配置启用，从受信任的远端发布源按平台下载、校验、安装、缓存、更新并切换到本地 active 版本；Runtime 自带的插件/技能随后由 Main 协调到 app-server。** 当前参考包证据不足以证明其 Electron 安装介质绝不携带任何 bootstrap 内容，也没有证明其 feed 使用客户端内置公钥签名；本项目选择“不内嵌完整 Runtime”，并在参考远端 feed 架构上增加客户端信任根、签名 config/manifest、防回滚和证据审计，这是明确的本项目安全增强，不冒充参考项目事实。

Primary Runtime 执行 PPT 任务时不依赖在线业务服务；但它的首次获取、升级、回滚防护和跨平台分发需要外部发布源。开发阶段应在本仓库搭建一个与生产协议相同的 HTTPS Runtime feed 服务，生产阶段可把同一只读协议部署到对象存储/CDN，不需要为 Runtime 另造模型推理服务。

本次“完成”只有一个含义：从空 Runtime 缓存启动桌面应用，Main 通过签名配置和发布清单取得真实 Runtime，验证并激活真实 `@oai/artifact-tool` 和 Presentations plugin；新任务获得一致的技能、提示和 `load_workspace_dependencies` 能力；真实模型根据 HTML 生成可打开、可渲染、无溢出的 `.pptx`。只接入 `codex-app-tools`、只让工具出现在 schema、只跑空壳 fixture 或改用 `officecli`/`python-pptx` 均不算完成。

## 2. Requirements Summary

1. 复刻参考项目的完整 Primary Runtime 架构，而不是为当前错误增加局部补丁。
2. 需要外部服务时，在仓库内实现可本地运行、可部署的开发服务；不得以“简单”为理由取消发布服务、签名配置或自动更新层。
3. Primary Runtime、Runtime bundled plugins、Presentations skill、`load_workspace_dependencies` 和实际工具执行必须由同一个 Main-owned 能力状态驱动。
4. 生产主链必须是 `Renderer → Preload → Electron Main → AI-free client → real codex app-server → item/tool/call → DynamicAppToolRegistry → Primary Runtime`；`codex-app-tools` MCP/Native Pipe 只是同一 registry 的兼容投影，不能成为唯一成功路径。
5. 不修改 `codex/codex-rs/app-server/**`，不新增桌面侧 LLM client，不把 Runtime root、签名私钥、下载凭据或任意文件系统能力暴露给 Renderer。
6. 不用测试适配掩盖客户端错误：本计划新增或修改的 Runtime/PPT 门禁不得增加失败掩盖型 `.skip`、`.only`、测试级 retry、放宽 timeout、假 `artifact-tool`、test-only IPC、假 registry、假 `item/tool/call` 或替代实现；仓库已有的合法平台/外部服务 skip 必须进入显式 allowlist，不能被本计划顺带删除或扩大。
7. 真实 Runtime 产物必须来自有权分发的来源并带可审计 provenance；不得直接复制参考项目包内的私有产物后发布。
8. 最终支持当前桌面发布矩阵：macOS x64、macOS arm64、Windows x64、Linux x64；每个目标同时声明最低 OS/ABI、平台原生签名与执行信任要求，开发可先在当前 macOS arm64 打通，但不能据此关闭跨平台发布门禁。

## 3. 根本原因与现状审计

### 3.1 参考项目实际上采用什么方案

参考项目证据证明其 Primary Runtime 主获取/更新链路使用外部配置与远端发布源：

- 它接收外部 `codex_runtimes_config`，配置变化会更新共享状态，见 [`main-Cwjv9Ibf.js:90026`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js#L90026>)。
- 更新器在启动时检查 missing/outdated，并按计划再次检查；缺失或过期时安装，见 [`main-Cwjv9Ibf.js:95592`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js#L95592>) 和 [`main-Cwjv9Ibf.js:95639`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js#L95639>)。
- Primary Runtime service 持有诊断、安装、取消、加载依赖、更新状态、手动更新和 reset，见 [`main-Cwjv9Ibf.js:96330`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js#L96330>) 至 [`main-Cwjv9Ibf.js:96445`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/main-Cwjv9Ibf.js#L96445>)。
- 默认发布根是 `https://persistent.oaistatic.com`，清单名为 `LATEST.json`，目标 URL 含平台/架构，见 [`src-PzwkD6WC.js:31302`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js#L31302>) 和 [`src-PzwkD6WC.js:31461`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/.vite/build/src-PzwkD6WC.js#L31461>)。
- `load_workspace_dependencies` 是宿主工具，调用 Primary Runtime service 并在未安装时返回结构化失败，不要求模型自己搜索目录或安装依赖，见 [`app-initial-DOX-K1rC.js:171349`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js#L171349>) 和 [`app-initial-DOX-K1rC.js:457478`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js#L457478>)。
- 工具是否进入目录由产品/功能能力决定，而不是以“此刻已经安装”为唯一条件，见 [`app-initial-DOX-K1rC.js:457250`](</Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified/webview/assets/app-initial-DOX-K1rC.js#L457250>)。

证据边界：以上事实支持“远端 config/feed、按目标下载、更新生命周期、Runtime service 和 loader 工具”这条主链；它们不能单独证明参考安装包完全没有 bootstrap Runtime，也不能证明参考 feed 采用本计划设计的离线签名、公钥 keyring、sequence 防回滚或双层 config/manifest 信任协议。计划和 ADR 必须把“参考事实”与“本项目安全增强”分栏记录。

参考项目索引已通过完整校验：7188/7188 文件、200 个位置记录一致；本次解包为 `beautified-fallback`，因此以上 readable-file SHA/行号是精确证据，但没有可补充的原包 raw 行列位置。关键文件 SHA256：`main-Cwjv9Ibf.js=f2cc48c767fb95d4f1ed5c9f847deefc65bbbb3e3e0bef4556264a515f70ef3a`、`src-PzwkD6WC.js=63a92f6c811355a447bb65029b4963f7552ed31607de88858e494da1c995a4f5`、`app-initial-DOX-K1rC.js=3e25e0c6cb4474d93afaff933c9f7473783d45002d0d8c641d0b5015019b13e4`。

### 3.2 本项目已经具备、应保留的能力

- Runtime v2 清单已经定义真实 Node、`@oai/artifact-tool`、可选 Python、二进制和 bundled plugins 布局，见 [`PrimaryRuntimeManifest.ts:60`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts#L60)。
- 诊断器明确要求 `@oai/artifact-tool`，不会把一个空目录误判为健康 Runtime，见 [`PrimaryRuntimeDiagnostics.ts:85`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeDiagnostics.ts#L85)。
- release provider 已经支持签名清单、平台/架构选择、序列回滚防护、HTTPS origin 白名单、流式下载、Content-Length 和 SHA-256 校验，见 [`PrimaryRuntimeReleaseProvider.ts:141`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L141) 和 [`PrimaryRuntimeReleaseProvider.ts:75`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L75)。
- installer 已经按文件流式解压，并通过不可变版本目录与 active pointer 激活，见 [`PrimaryRuntimeInstaller.ts:43`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L43) 和 [`PrimaryRuntimeActivePointer.ts:38`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivePointer.ts#L38)。
- Main 已把 Primary Runtime service 作为 `DesktopHostCapabilityRuntime` 的依赖，并把同一 registry 投影给原生 dynamic tools 与兼容 Pipe，见 [`index.ts:196`](../../desktop-app/src/main/index.ts#L196)、[`DesktopHostCapabilityRuntime.ts:41`](../../desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts#L41) 和 [`index.ts:405`](../../desktop-app/src/main/index.ts#L405)。
- Runtime 健康后，Main 能发现 Runtime 声明的 bundled plugin marketplace，见 [`BundledPluginDescriptors.ts:210`](../../desktop-app/src/main/bundledPlugins/BundledPluginDescriptors.ts#L210)。
- 新 thread 已通过 `thread/start.dynamicTools` 发布快照，而 resume 不伪造工具目录，见 [`NativeCodexRunDriver.ts:572`](../../desktop-app/src/main/codexRun/NativeCodexRunDriver.ts#L572)。
- 已有真实 Runtime 组件 smoke 和 Presentations artifact smoke 脚本，可继续作为组件门禁，见 [`package.json:54`](../../desktop-app/package.json#L54) 至 [`package.json:57`](../../desktop-app/package.json#L57)。

### 3.3 导致本次失败的结构性缺口

1. **没有可用的默认供应链。** Main 只有在环境变量给齐 direct release 或 signed manifest 时才配置 provider，见 [`runtimeConfig.ts:27`](../../desktop-app/src/main/runtimeConfig.ts#L27) 和 [`index.ts:204`](../../desktop-app/src/main/index.ts#L204)。普通开发/产品启动不会自动获得 Runtime。
2. **签名路径默认无法启动。** 产品公钥表目前为空，而 provider 明确拒绝空 keyring，见 [`PrimaryRuntimeReleaseManifest.ts:50`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseManifest.ts#L50) 和 [`PrimaryRuntimeReleaseProvider.ts:166`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L166)。
3. **缺少真实 Runtime bundle 构建与发布者。** 当前仓库能消费 archive，却没有从授权源组装 Node、artifact-tool、所需二进制和 `openai-primary-runtime` plugins、生成清单、签名并发布多平台产物的生产者。
4. **只有一次性启动安装，不是参考项目式生命周期。** 目前启动时仅对 missing Runtime 调一次 `install()`，没有 remote config refresh、定时检查、jitter、last-known-good 或计划更新，见 [`index.ts:371`](../../desktop-app/src/main/index.ts#L371) 和 [`PrimaryRuntimeService.ts:86`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts#L86)。
5. **工具、提示与技能暴露状态不一致。** 当前 `load_workspace_dependencies` 在 Runtime 未 ready 时被 availability 过滤掉，见 [`desktopToolDefinitions.ts:67`](../../desktop-app/src/main/appTools/desktopToolDefinitions.ts#L67)；与此同时，已有 plugin cache 可能仍使 Presentations skill 可见。这会把模型放进“知道要用 Runtime，但没有诊断工具”的状态。
6. **已有 E2E 不是实包闭环。** `app-tools-host.e2e.ts` 使用最小 fixture，`PrimaryRuntimeRealSmoke.test.ts` 依赖显式本地 root，`run-presentations-runtime-smoke.mjs` 直接调用 Runtime；这些分别证明协议、真实目录和 artifact-tool 组件，但都没有证明“空缓存 → 远端签名 feed → Main 激活 → app-server 工具调用 → AI 生成 PPT”。
7. **live LLM suite 没有 Presentations 场景。** 当前真实模型只覆盖 R01-R06，见 [`release-llm.e2e.ts:48`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L48) 至 [`release-llm.e2e.ts:210`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L210)；“出现任意 tool group”的断言不能证明 Runtime/PPT 因果链，见 [`release-llm.e2e.ts:399`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L399)。

因此，错误“环境中缺少 `@oai/artifact-tool` 运行时”的根因不是 Presentations skill 文案，也不是 `codex-app-tools` 没装好，而是**Runtime 生产、发布、发现、安装、更新、插件同步和对话能力发布没有形成闭环**。

## 4. 目标架构与不变量

```text
授权的 Runtime 输入源
  Node / Python / artifact-tool / native binaries / Primary Runtime plugins
                          │
                          ▼
跨平台 Runtime Builder ──生成──> immutable archives + runtime.json + provenance
                          │
                          ▼
离线 Manifest Signer ───签名───> runtime-config.json + channel manifest
                          │
                          ▼
开发 HTTPS Feed / 生产对象存储+CDN
  config.json   manifest.json   archives/<version>/<target>.zip
                          │
                          ▼
Electron Main Product Config → Signed Release Provider → Installer → Active Pointer
                          │                              │
                          │                              ├─ Runtime bundled plugins reconcile
                          │                              └─ capability revision/state event
                          ▼
DesktopHostCapabilityRuntime（唯一能力快照）
       ├─ thread/start.dynamicTools → real app-server → item/tool/call
       ├─ codex_app MCP/Native Pipe（兼容投影）
       ├─ workspace dependency instructions
       └─ Runtime plugin/skill eligibility
                          │
                          ▼
真实 AI 使用 Runtime Node + @oai/artifact-tool 生成、校验、渲染并展示 PPTX
```

必须保持以下不变量：

1. **信任根在客户端，私钥在发布端。** Main 内置允许的公钥和 production origin；签名私钥只存在于发布环境或开发者本地 gitignored 目录。
2. **外部配置不能扩大信任域。** 远端 config 可以选择 channel、版本策略和轮询周期，但不能引入客户端未内置的新公钥或任意 archive origin。
3. **archive 不可变，可信 metadata 只能单调推进。** archive URL 含版本和目标并设置 immutable cache；config 与 channel manifest 分别使用独立的签名角色和 monotonic state。客户端持久化 `{sequence, payloadHash, keyId}`；同 sequence、同 payload 只允许幂等重放，同 sequence、不同 payload 必须按 equivocation 拒绝，不能只比较整数。
4. **last-known-good 永远优先于坏更新，激活是一个可恢复事务。** 下载、签名、解压、诊断、候选 plugin desired-set reconcile/readback、active pointer 提交、plugin generation 提交和 capability revision 发布属于同一个 Main-owned activation operation。任一步失败都必须通过 journal/补偿恢复旧 pointer 与旧 Runtime-owned plugin set；未通过完整事务的候选版本不得对新 thread/turn 可见。
5. **能力状态唯一且只读取已提交 generation。** `load_workspace_dependencies`、workspace instructions、Runtime plugin/skill eligibility、Plugin Center 和新 thread admission 都读取同一个 Main-owned committed activation generation，禁止各自扫描文件或读 plugin cache 猜测；激活 critical section 内的新 thread/turn 必须等待或继续使用旧 generation，不能取得一半新、一半旧的状态。
6. **诊断工具可达。** 只要本地 host 支持 Primary Runtime 且产品功能已启用，`load_workspace_dependencies` 就在新 thread 工具目录中；missing/installing/broken 时返回结构化状态与恢复建议，不让模型搜索私有目录、安装 npm/pip 包或换工具链。
7. **技能只在可执行时出现，但不伪造 app-server 不支持的任务级能力。** P0 必须先证明 app-server 的 plugin/skill catalog 是 per-thread snapshot 还是全局目录，并记录具体协议入口。如果没有 per-thread skill filter，则采用“全局 committed plugin generation + Main resume admission guard”：安装前创建且没有 loader 的 legacy thread 在新 Runtime plugin 激活后不得启动不一致的新 turn，UI 必须提示新建任务；初始目录已有 loader 的 thread 可以在 commit 后读取新 Runtime。恢复旧 thread 不补发 `dynamicTools`，不修改 app-server 语义。
8. **原生 dynamic tools 是生产主链。** MCP/Pipe 失败只能降级兼容入口，不得让 native `item/tool/call → registry` 一并失效。
9. **无替代生成器。** Presentations 任务禁止用 `officecli`、`python-pptx`、系统 Node、临时 npm/pip 安装或复制预生成 PPT 伪造成功。
10. **平台可执行信任是 Runtime 信任的一部分。** archive 签名和 SHA 不能替代 macOS code signing/notarization、Windows Authenticode/SmartScreen 策略、Linux ABI/依赖基线及 clean-machine execution smoke；不满足目标平台执行信任的 bundle 不得进入 feed。

## 5. Implementation Steps

### P0：固化产品协议、完成定义和供应权边界

涉及文件：

- 新增 `docs/adr/2026-09-09-primary-runtime-reference-delivery.md`
- 新增 `docs/specs/primary-runtime-feed-v1.md`
- 新增 `docs/specs/primary-runtime-activation-transaction.md`
- 新增 `docs/specs/primary-runtime-capability-generation.md`
- 新增 `primary-runtime/runtime-sources.lock.json`
- 修改 [`desktop-app/tests/app-tools-release-gates.json`](../../desktop-app/tests/app-tools-release-gates.json)
- 修改 [`desktop-app/scripts/verify-app-tools-release-gates.mjs`](../../desktop-app/scripts/verify-app-tools-release-gates.mjs)

工作项：

1. ADR 把“参考项目已证明的远端 config/feed/update/loader 主链”和“本项目增加的签名信任根、防回滚、不内嵌完整 Runtime”分开记录；明确选择“远端签名 feed + 本地可信安装/更新”，否决“Electron 内嵌完整 Runtime”“仅开发 root”“只装 codex-app-tools”“运行时临时 npm/pip 安装”四种替代方案。
2. Feed v1 规范定义目标命名、config、manifest、archive、签名 canonicalization、独立 config/manifest key role 与 sequence store、`{sequence,payloadHash,keyId}` 接受规则、有效期、缓存头、错误码、最大体积、origin 规则和 key rotation/revocation；远端 metadata 不得引入客户端未内置的新信任根。
3. `runtime-sources.lock.json` 只记录有权分发的输入：名称、版本、来源、许可证/授权记录 ID、平台、原始 SHA、构建器版本；不得记录访问 token。`@oai/artifact-tool` 和 Runtime plugins 没有授权或 clean-room 产物时，`AT-RT-PROVENANCE-01` 必须失败关闭。
4. 把现有门禁拆成真实生产者：`AT-RT-PROVENANCE-01`、`AT-RT-BUILD-01`、`AT-FEED-01`、`AT-RT-UPDATE-01`、`AT-SKILL-CAP-01`、`AT-E2E-01`、`AT-LIVE-01`、`AT-LIVE-PKG-01` 和现有三平台 packaged gates。gate 只能由带 commit、bundle SHA、manifest sequence、目标平台和报告 SHA 的证据关闭。
5. `primary-runtime-activation-transaction.md` 定义 prepare、candidate diagnostics、candidate plugin staging、critical-section admission barrier、pointer/plugin generation/capability commit、readback、失败补偿和 crash recovery journal。candidate plugin 默认只能安装为 disabled；若现有 app-server catalog API 无法做到“安装但不启用”，barrier 必须在第一次 plugin mutation 前建立并持续到 commit/rollback 完成。禁止把“先发布 pointer、随后尽力 reconcile”描述为成功激活。
6. `primary-runtime-capability-generation.md` 先从生成协议和当前 client 证明 app-server plugin/skill catalog 的真实作用域。若没有 per-thread skill filter，固定采用全局 committed plugin generation 与 Main resume admission guard，禁止实现客户端伪造的 per-thread skill catalog。

验收：

- 规范中的每个字段都有 parser/producer/consumer 所有者和失败策略。
- verifier 对缺 provenance、未知 key、倒退 sequence、同 sequence 不同 payload、错误 artifact SHA、证据 commit 不一致和手写 `covered` 全部失败。
- P0 不以“尚未取得私有产物”为由删除 provenance gate；无授权时只能保持发布 blocked。
- P0 结束前必须有一份可执行的 capability-scope 结论：要么给出 app-server 原生 per-thread skill 入口及契约测试，要么启用 global generation + resume admission guard，不能把这个决定留给实施者猜测。

### P1：建立真实、可复现的多平台 Runtime bundle 生产线

涉及文件：

- 新增 `primary-runtime/README.md`
- 新增 `primary-runtime/package.json`
- 新增 `primary-runtime/bundle-manifest.schema.json`
- 新增 `primary-runtime/target-compatibility.json`
- 新增 `primary-runtime/runtime-fonts.lock.json`
- 新增 `primary-runtime/scripts/build-runtime.mjs`
- 新增 `primary-runtime/scripts/verify-runtime.mjs`
- 新增 `primary-runtime/scripts/verify-platform-trust.mjs`
- 新增 `primary-runtime/scripts/create-provenance.mjs`
- 新增 `primary-runtime/tests/build-runtime.node-test.mjs`
- 新增 `.github/workflows/primary-runtime-build.yml`
- 复用并扩展 [`PrimaryRuntimeManifest.ts:60`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts#L60) 的 v2 contract
- 复用 [`run-presentations-runtime-smoke.mjs`](../../desktop-app/scripts/run-presentations-runtime-smoke.mjs)

工作项：

1. Builder 从受信任、版本锁定的输入组装 `dependencies/node`、`dependencies/python`、`dependencies/native`、`plugins/openai-primary-runtime` 和经许可的中文字体/回退配置，生成 v2 `runtime.json`；每个平台必须携带实际需要的可执行文件和库，不借用开发机全局 PATH。
2. 对 Node package 做真实加载与版本核验，尤其是 `@oai/artifact-tool`；对 Python package 做 import/version 核验；对 git/pnpm/pdfinfo/pdftoppm/soffice 做可执行与版本核验。
3. `target-compatibility.json` 为每个目标声明最低 OS、CPU、ABI/运行库基线和必需的系统能力：macOS deployment target 与签名/notarization 要求、Windows 最低版本与 Authenticode 策略、Linux distro/glibc 基线；client 在下载前拒绝不兼容目标。
4. ZIP 生产者必须是一个经许可证/安全审查、版本锁定的 streaming archive writer；Node 标准库不被描述为 ZIP 实现。固定 entry 顺序、时间戳、权限和压缩参数，并记录 writer/version。可复现门槛以 canonical unsigned file manifest 为基础；只有当平台签名后的输入文件也是固定 immutable 输入时，才要求重建 archive SHA 完全一致，不能用“非签名字节”这种无法审计的模糊口径。
5. 平台可执行文件在 archive 前完成原生签名；CI 在 clean runner 验证 macOS code signature/notarization ticket、Windows Authenticode chain 和 Linux ELF interpreter/动态库/GLIBC 上限。archive 外层 SHA/manifest 签名不能替代这些检查。
6. 构建矩阵按 [`desktop-release.yml:137`](../../.github/workflows/desktop-release.yml#L137) 对齐 macOS x64/arm64、Windows x64、Linux x64。每个 job 运行 diagnostics、platform trust、real runtime smoke、中文字体渲染和 Presentations runtime smoke 后才上传 archive、runtime manifest、SBOM/provenance。
7. Runtime plugin marketplace 中至少包含正式 Presentations skill 及其直接依赖；不能把用户个人 cache 或参考项目解包目录当作构建输入。

验收：

- 四个目标从 clean runner 构建并通过 `verify-runtime.mjs`。
- 每个 archive 解压后都被 `PrimaryRuntimeDiagnostics` 判定为 ready，真实加载 `@oai/artifact-tool` 并生成至少 3 页 PPTX。
- 两次 clean build 的 canonical file manifest/SBOM/provenance 一致；固定的已签名输入产生同一 archive SHA。archive 内无绝对路径、symlink、越界 entry、开发证书、私钥、token、用户目录或 reference-projects 路径。
- 每个平台在最低支持系统的 clean runner 上执行 Runtime Node、artifact-tool、LibreOffice 和中文 PPT render；签名、notarization/Authenticode、ABI 或字体回退任一不满足即不发布。

### P2：搭建与生产协议相同的开发 Runtime feed 服务

涉及文件：

- 新增 `services/primary-runtime-feed/package.json`
- 新增 `services/primary-runtime-feed/src/server.mjs`
- 新增 `services/primary-runtime-feed/src/repository.mjs`
- 新增 `services/primary-runtime-feed/scripts/publish-release.mjs`
- 新增 `services/primary-runtime-feed/scripts/sign-config.mjs`
- 新增 `services/primary-runtime-feed/scripts/sign-manifest.mjs`
- 新增 `services/primary-runtime-feed/tests/feed-contract.node-test.mjs`
- 新增 `services/primary-runtime-feed/README.md`
- 新增 `services/primary-runtime-feed/.gitignore`
- 修改 [`desktop-app/package.json:11`](../../desktop-app/package.json#L11)

服务协议：

- `GET /v1/runtime/config.json`：返回签名的产品 Runtime 配置，包含 schemaVersion、sequence、channel、manifest URL、poll interval、有效期和 keyId。
- `GET /v1/runtime/channels/<channel>/manifest.json`：返回已签名的目标发布清单。
- `GET /v1/runtime/archives/<version>/<platform>-<arch>/primary-runtime.zip`：只读、不可变 archive，带准确 Content-Length、ETag、`Cache-Control: immutable`，拒绝目录遍历和未发布文件。
- 发布不是在线请求：`publish-release.mjs` 在 staging 中校验完整矩阵和 provenance，原子推进 manifest/config；服务进程只负责 GET/HEAD，不接收上传、不持有模型凭据。

工作项：

1. 服务使用 Node 22 标准 HTTPS 和只读文件仓库，先满足本机和 CI，再允许将相同目录同步到 S3/R2/OSS/CDN；客户端协议不因部署介质变化。
2. 本地开发证书/私钥必须由开发者生成到 gitignored `var/tls/`；测试可使用明确标记为 test-only 的 CA fixture。CA 只通过 Main-owned `PrimaryRuntimeTlsPolicy`/受控测试启动配置进入 Runtime HTTP client，production build 必须拒绝 custom CA 和 test pin，Renderer、app-server 与全局进程 TLS 状态均不得接收它。
3. 私有签名密钥只由 signer 读取；feed 目录仅保存签名后的 JSON 和 archive。key rotation 必须允许旧/新公钥交叠，并测试旧 key 撤销后的行为。
4. 增加一个开发编排命令 `npm --prefix desktop-app run dev:with-primary-runtime-feed`，启动本地 HTTPS feed、发布当前平台的开发 bundle、再启动 Electron；它只能设置 config URL/CA 等产品级配置，不得设置 `DASCOWORK_PRIMARY_RUNTIME_ROOT` 或 direct archive override。
5. config、manifest、archive GET/HEAD 必须复用同一个 `PrimaryRuntimeHttpClient` 和 origin/TLS policy；不得分别调用裸 `fetch`，不得使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、忽略证书错误或允许任意重定向扩大 origin。

验收：

- 从空 feed 发布一个完整矩阵后，config/manifest/archive URL 均符合规范；重复发布同版本不会覆写不同 SHA 的 archive。
- 并发读 manifest 时发布新版本，客户端只会读到旧或新完整文件，不会读到半个 JSON。
- path traversal、错误 Host/origin、无 TLS、错误 Content-Length、过期 config、未知 key 和 rollback sequence 全部失败。
- 同一测试既能指向本地 HTTPS 服务，也能指向静态目录/CDN emulator，不改客户端代码。
- dev/CI CA 仅能连接被配置的本地 feed host；相同 CA 对其他 host、Renderer 请求、app-server 请求和 production build 均无效，证书过期、SAN 不匹配和 pin 不匹配全部失败。

### P3：把客户端从“环境变量才有 Runtime”升级为产品配置与可信更新生命周期

涉及文件：

- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeProductConfig.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeProductConfigClient.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeHttpClient.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeTrustStateStore.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivationTransaction.ts`
- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeUpdateCoordinator.ts`
- 新增相应 unit tests
- 修改 [`runtimeConfig.ts:1`](../../desktop-app/src/main/runtimeConfig.ts#L1)
- 修改 [`PrimaryRuntimeReleaseManifest.ts:50`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseManifest.ts#L50)
- 修改 [`PrimaryRuntimeReleaseProvider.ts:141`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeReleaseProvider.ts#L141)
- 修改 [`PrimaryRuntimeService.ts:19`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.ts#L19)
- 修改 [`PrimaryRuntimeInstaller.ts:43`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeInstaller.ts#L43)
- 修改 [`PrimaryRuntimeActivePointer.ts:38`](../../desktop-app/src/main/primaryRuntime/PrimaryRuntimeActivePointer.ts#L38)
- 修改 [`BundledPluginManager.ts:89`](../../desktop-app/src/main/bundledPlugins/BundledPluginManager.ts#L89)
- 修改 [`BundledPluginReconcileCoordinator.ts`](../../desktop-app/src/main/bundledPlugins/BundledPluginReconcileCoordinator.ts)
- 修改 [`index.ts:190`](../../desktop-app/src/main/index.ts#L190) 与 [`index.ts:371`](../../desktop-app/src/main/index.ts#L371)
- 修改 [`desktop-app/.env.example`](../../desktop-app/.env.example) 和 [`desktop-app/README.md`](../../desktop-app/README.md)

工作项：

1. 应用随发布 channel 内置 production config endpoint、production archive origins，以及 config-signing/manifest-signing 两个 role 当前与下一把可轮换公钥；公钥 ID、role 与发布服务一致。环境变量 direct release 保留为显式开发/企业离线覆盖，不再是普通产品启动的必要条件。
2. Product config client 与 release provider 复用 `PrimaryRuntimeHttpClient`，分别验证 config/manifest 的签名角色、有效期、sequence、channel、endpoint origin 和 TLS policy。远端 config 只能在内置 origin/keyring 范围内调整 manifest URL、更新间隔和 rollout，不得写入 renderer 或 app-server config。
3. `PrimaryRuntimeTrustStateStore` 为 config 和 manifest 分别原子持久化 `{sequence,payloadHash,keyId,acceptedAt}`；同 sequence、同 hash/key 可幂等读取，同 sequence、不同 payload/key 作为 equivocation 失败，低 sequence 作为 rollback 失败。缓存必须绑定已验签 payload hash、origin、channel 和 key role，不能只凭文件存在复用。
4. `PrimaryRuntimeUpdateCoordinator` 复制参考项目的生命周期：启动立即检查；missing/broken/outdated 时安装；成功后按带 jitter 的周期检查；网络失败指数退避；app 退出取消；手动 install/repair/update 与后台任务共享单一 in-flight operation。
5. `PrimaryRuntimeService` 增加明确状态机：`disabled | checking | missing | downloading | verifying | installing | staging-plugins | committing | rolling-back | ready | update-available | failed | unsupported`，每次迁移包含 operationId、oldGeneration、targetGeneration、activeVersion、targetVersion、manifestSequence、阶段和安全错误码。
6. 将 installer 拆成“prepare immutable candidate”和“由 activation transaction 提交”两部分；installer 不再独立 publish active pointer。`PrimaryRuntimeActivationTransaction` 持久化 operation journal，在 admission barrier 内完成 candidate plugin staging/readback、pointer/plugin generation/capability commit 与最终 readback；任一步失败都按 journal 补偿回旧 pointer、旧 Runtime-owned plugin enabled set 和旧 capability generation。
7. update 过程中已经开始的 turn 固定使用旧 committed generation；需要新 capability snapshot 的 thread/turn 在 critical section 内等待，或明确继续读取旧 generation。禁止先发布 pointer、随后异步尽力 reconcile，也禁止 reconcile 失败后仍 refresh 为 ready。
8. config/manifest 缓存只作为网络不可用时的 last-known-good 输入；过期签名 metadata 不能安装新版本，但已有已验证 active Runtime 可继续执行。
9. Main 启动和 dispose 明确拥有 coordinator；普通聊天不得等待 Runtime 下载完成。后台自动激活只有在 P4 capability/admission gates 已接通后才能默认启用，防止实现阶段出现可被用户命中的半套架构；不重启整个 app-server 连接。

验收：

- 在没有任何 Runtime 环境变量、空 userData/cache 的情况下，应用仅凭内置 config endpoint/keyring 安装成功。
- startup missing、scheduled outdated、manual update、repair、cancel、offline、HTTP 500、坏 TLS/签名、同 sequence 不同 payload、坏 SHA、坏 archive、诊断失败、plugin staging/readback 失败、pointer commit 失败、磁盘不足、进程中断恢复和 rollback attack 均有 unit/integration 证据。
- update 期间已打开任务继续使用 old active Runtime；指针发布后新调用只看到完整新版本，不出现 active 空窗或混用两个版本。
- config/feed 不可用不会拖垮普通聊天；没有健康 Runtime 时不会宣称 Presentations 可执行。
- 故障注入覆盖 transaction 每一个 durable step；进程重启后只能恢复为完整旧 generation 或完整新 generation，不允许 pointer、plugin enabled set 与 capability revision 分属不同版本。

### P4：统一 Runtime、工具、提示、插件和技能的能力状态

涉及文件：

- 新增 `desktop-app/src/main/primaryRuntime/PrimaryRuntimeCapabilityPolicy.ts`
- 新增 `desktop-app/src/main/primaryRuntime/ThreadCapabilityGenerationStore.ts`
- 修改 [`desktopToolDefinitions.ts:58`](../../desktop-app/src/main/appTools/desktopToolDefinitions.ts#L58)
- 修改 [`DesktopHostCapabilityRuntime.ts:17`](../../desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts#L17)
- 修改 [`DynamicAppToolRegistry.ts`](../../desktop-app/src/main/appTools/DynamicAppToolRegistry.ts)
- 修改 [`codexChatRuntimeService.ts:743`](../../desktop-app/src/main/codexChatRuntimeService.ts#L743)
- 修改 [`BundledPluginDescriptors.ts:210`](../../desktop-app/src/main/bundledPlugins/BundledPluginDescriptors.ts#L210)
- 修改 [`BundledPluginManager.ts:89`](../../desktop-app/src/main/bundledPlugins/BundledPluginManager.ts#L89)
- 修改 [`BundledPluginReconcileCoordinator.ts`](../../desktop-app/src/main/bundledPlugins/BundledPluginReconcileCoordinator.ts)
- 修改 [`PluginCenterService.ts:238`](../../desktop-app/src/main/pluginCenter/PluginCenterService.ts#L238)
- 修改 [`index.ts:230`](../../desktop-app/src/main/index.ts#L230)
- 修改 AI-free client/plugin catalog adapter 与相应生成协议契约测试；只使用 app-server 已有能力，不修改 `codex/codex-rs/app-server/**`
- 修改对应 Main/unit/Electron E2E tests

工作项：

1. `PrimaryRuntimeCapabilityPolicy` 根据产品 feature、host、committed activation generation、active bundle revision 和 committed plugin generation 生成一个不可变 capability snapshot；其输出同时决定 dynamic tool 目录、workspace instructions、bundled plugin eligibility、Plugin Center 状态、新 thread/turn admission 和“需新建任务”提示。任何 consumer 都不能读取未提交 candidate generation。
2. 当本地 host 支持且功能开启时，`load_workspace_dependencies` 始终进入**新 thread** 原生工具目录。执行时重新读取当前 Runtime state：ready 返回精确路径；missing/installing/broken/unsupported 返回结构化 `{status, operationId?, activeVersion?, issues, recovery}`，不吞掉具体错误为统一字符串。
3. 为 internal plugin 建立显式 owner：`app-bundled` 与 `primary-runtime:<bundleRevision>`。`BundledPluginManager` 从“只安装/升级/启用”改为完整 desired-state reconcile：安装/升级/启用当前 desired set，停用或退役旧 Runtime-owned set，并回读确认；不得停用用户安装或其他 owner 的插件。
4. `index.ts` 的 internal descriptor 状态采用当前 committed desired set 的替换语义，不再把历史 descriptor 做 union 累积。Plugin Center、权限判断和 internal-plugin 检查只读取相同 committed set。
5. P0 若证明 app-server 有原生 per-thread skill snapshot，则在该协议入口绑定 thread capability generation；否则不得声称存在 per-thread skill filter，采用全局 committed plugin generation。`ThreadCapabilityGenerationStore` 记录每个本地 thread 创建时是否包含 loader：legacy thread 在全局 Runtime skill 已激活但自身没有 loader 时，Main 拒绝启动不一致的新 turn 并返回结构化 `new-thread-required`；已有 loader 的 thread 可在 activation commit 后读取新 Runtime。
6. candidate plugin staging 必须保持候选 Runtime plugin 为 disabled；若 catalog API 安装时必然启用，则 activation barrier 从第一次 plugin mutation 前开始。barrier 暂停需要新 catalog/snapshot 的 thread/turn admission，切换 pointer 与 Runtime-owned plugin enabled set，回读后一次发布 committed generation；失败执行补偿再解除 barrier。已经运行的 turn 不被中断，也不热改其 dynamic tool 目录。
7. workspace dependency instructions 只在 snapshot 同时满足 `runtime ready + loader published + matching committed plugin generation` 时注入。禁止 skill 可见而 loader 不可见，也禁止 loader 返回 ready 但路径指向其他 bundle revision。
8. `codex-app-tools` MCP/Native Pipe 与原生动态工具继续复用 `DynamicAppToolRegistry`；增加回归测试证明关闭 Pipe 后 native dynamic tool 仍可完成调用。

验收：

- 枚举 `disabled/missing/installing/broken/ready/update-in-progress/unsupported` 与 Pipe `ready/unavailable` 的组合，断言不存在“Presentations skill 可见但 loader 不存在”或“skill 指向旧 bundle”的状态。
- missing 状态的新 thread 能调用 loader 获得可操作的结构化诊断；模型不需要 shell 搜索 `~/.codex`、用户目录或参考项目。
- Runtime 激活前创建的旧 thread、激活后 resume、激活后新 thread 三个场景均符合 `thread/start`/`thread/resume` 协议边界。
- v1 → v2 → v3 的 desired-set 测试证明 v1/v2 Runtime-owned descriptor 和已安装插件不会在 v3 继续可见/启用；同名用户插件不受影响，`index.ts` 内存集合也不保留历史 descriptor。
- 在 activation transaction 的每个可持久化步骤注入故障并并发发起 thread/turn：请求只能读到完整旧 generation、等待后读到完整新 generation，或收到结构化 `new-thread-required`，绝不能看到新 skill + 旧/缺失 loader。
- 若最终采用全局 plugin generation，验收和文档不得出现“app-server 为旧 thread 保留旧 skill catalog”的表述；legacy thread resume guard 必须是真实 Main production 路径，不是 E2E 特例。
- MCP/Pipe 插件未安装或故障时，native `item/tool/call → registry` 用例仍通过；反之两条投影返回同一 handler 的语义等价结果。

### P5：提供 Main-owned 的安装/修复/更新可见性与用户恢复路径

涉及文件：

- 修改 `desktop-app/src/shared/pluginCenterApi.ts`
- 修改 `desktop-app/src/main/pluginCenter/PluginCenterService.ts`
- 修改 `desktop-app/src/main/pluginCenter/registerPluginCenterIpc.ts`
- 修改 `desktop-app/src/preload/pluginCenterBridge.ts`
- 修改 `desktop-app/src/renderer/src/components/plugin-center/PluginCenterPage.tsx`
- 修改对应 shared/Main/preload/renderer tests

工作项：

1. 在现有 Plugins/Skills 管理界面展示 Primary Runtime：当前/目标版本、checking/downloading/installing/reconciling/ready/failed、下载进度、最近安全错误和下次检查时间。
2. 只暴露白名单业务操作：`getStatus`、`installOrRepair`、`runUpdateNow`、`cancel`。Renderer 不接收 feed URL、origin allowlist、public/private keys、Runtime root、archive 路径或原始错误堆栈。
3. 安装/修复成功后刷新 Plugin Center 数据与 capability revision，并提示创建新任务；不自动修改或重启用户正在进行的 turn。
4. 失败信息区分可恢复网络问题、不可恢复签名/完整性问题、无支持平台、磁盘不足和 provenance/feature disabled；签名/完整性失败不提供“忽略并安装”。

验收：

- UI 从 Main state event 驱动，不自己轮询文件系统；窗口重载可恢复准确状态。
- cancel 后 staging 被清理、active 版本不变；repair 后新 task 可看到 Presentations skill 和 loader。
- preload/shared schema 拒绝额外字段与任意路径输入，Renderer bundle 静态检查无 Runtime secret/root API。

### P6：建立真实 feed 的确定性全链 Electron E2E

涉及文件：

- 新增 `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts`
- 修改 [`app-tools-host.e2e.ts`](../../desktop-app/tests/e2e/app-tools-host.e2e.ts)，保留其协议 fixture 定位
- 修改 [`tests/e2e/support/app.ts`](../../desktop-app/tests/e2e/support/app.ts)
- 修改 [`tests/e2e/support/mockBackend.ts`](../../desktop-app/tests/e2e/support/mockBackend.ts)
- 新增 `desktop-app/scripts/run-primary-runtime-feed-e2e.mjs`
- 修改 [`package.json:20`](../../desktop-app/package.json#L20)

边界：

- 只允许 mock 外部模型 HTTP 响应；Electron Renderer、Preload、Main、Primary Runtime client/service/coordinator、AI-free client、真实 `codex app-server`、native dynamic tool dispatcher、plugin manager 和真实 Runtime archive 全部使用生产实现。
- 测试从空 userData/CODEX_HOME/runtime cache 开始，指向本地 HTTPS feed；不得设置 `DASCOWORK_PRIMARY_RUNTIME_ROOT`、direct release 五元组或 `CODEX_APP_SERVER_BIN` 替身。

用例：

1. 启动应用，观察 config/manifest/archive 请求；验证 Main 安装、诊断、原子激活并 reconcile Runtime Presentations plugin。
2. 创建新任务；scripted model 第一步调用 `load_workspace_dependencies`，第二步依据真实 tool output 发起批准后的 Runtime Node 命令，第三步只在收到命令结果与 artifact 信息后结束。
3. 断言 provider 请求中的工具 schema、app-server loader `item/tool/call`、registry output、后续命令 item、artifact 注册和 UI tool item 位于同一 `threadId/turnId` 的有序因果链。loader 与命令是不同 item，分别记录 `loaderCallId` 和 `commandItemId/requestId`，禁止伪造一个跨两次调用共享的 callId。
4. 断言命令实际使用 loader 返回的 Runtime Node 和 `NODE_PATH`；禁止出现 system `node`、`npm install`、`pip install`、`officecli` 或 `python-pptx`。
5. 推进 feed 到新版本，覆盖旧任务 resume 与新任务 snapshot；测试坏 manifest/坏 archive 时继续使用 last-known-good。

验收：

- `AT-E2E-01` 由真实 app-server + 真实 feed + 真实 Runtime + native registry 关闭；现有最小 fixture 测试只保留为快速协议回归，不再被引用为 Runtime/PPT 完成证据。
- 输出证据包含 commit、Runtime bundle version、manifest sequence/config sequence 及 payload hash/keyId、archive SHA、threadId、turnId、loaderCallId、loader output hash、commandItemId/requestId、command output hash、artifact source ID、PPT SHA 和 UI open receipt；缺任何一项门禁失败。
- 静态 verifier 拒绝 fake artifact-tool、fake registry、test-only bridge、自建 Pipe tool response、直接调用 `hostCapabilities.dispatch` 和 direct Runtime root。

### P7：加入真实 AI 的 HTML → AI Agent 安全市场 PPT 验收

涉及文件：

- 修改 [`release-llm.e2e.ts:48`](../../desktop-app/tests/e2e/release-llm.e2e.ts#L48)，新增独立 R07 Presentations 场景
- 修改 [`run-dev-llm-smoke.mjs`](../../desktop-app/scripts/run-dev-llm-smoke.mjs)
- 修改 [`run-release-llm-smoke.mjs`](../../desktop-app/scripts/run-release-llm-smoke.mjs)
- 新增 `desktop-app/tests/fixtures/presentations/ai-agent-security-market.html`
- 新增 `desktop-app/tests/fixtures/presentations/ai-agent-security-market.expected.json`
- 新增 `desktop-app/scripts/verify-live-presentation-artifact.mjs`
- 复用 [`run-presentations-runtime-smoke.mjs`](../../desktop-app/scripts/run-presentations-runtime-smoke.mjs) 的 render/overflow/integrity 检查
- 修改 [`artifactPreviewApi.ts:14`](../../desktop-app/src/shared/artifactPreviewApi.ts#L14) 与 [`ArtifactPreviewSourceService.ts`](../../desktop-app/src/main/artifacts/ArtifactPreviewSourceService.ts)，只在现有生产 artifact 注册协议需要补足 provenance 字段时修改
- 修改 [`workspaceOpenTargets.ts:176`](../../desktop-app/src/renderer/src/components/workspace-container/workspaceOpenTargets.ts#L176)，验证生产 workspace-file → presentation preview 路径
- 修改 [`right-workspace.e2e.ts`](../../desktop-app/tests/e2e/right-workspace.e2e.ts) 增加真实产物打开验证

R07 用户提示词固定为语义等价的：

> 分析当前项目中的 HTML 内容，生成一份 AI agent 安全市场的简单分析 PPT。使用 Presentations 能力和工作区提供的 Primary Runtime；完成后给出可打开的 PPTX。不得安装或切换到替代 Office/Python/Node 工具链。

工作项：

1. fixture HTML 包含可核对的数据、来源标识、中文文本和最少三个市场维度；配套 `expected.json` 记录事实 ID、允许的格式化/舍入规则、必须出现的页类和禁止凭空增加的事实。AI 必须先读 HTML，再调用 loader，再用 Runtime `@oai/artifact-tool` 创作，不接受直接复制预制 PPT。
2. 追踪同一 turn 的 loaderCallId、loader output、命令审批/commandItemId、执行结果、workspace artifact registration、右侧工作区打开事件和最终消息；检查命令行和环境确实来自 loader result，并记录 bundle/archive/PPT SHA。事件用各自真实 ID 和有序关系关联，不能要求共享一个 callId。
3. 产物至少包含封面、市场概览、细分/竞争格局、趋势/风险、结论五类页面；验证器按 `expected.json` 的事实 ID/值/舍入规则检查数字与 HTML 一致，模型推断必须显式标为分析，不能把常识冒充输入事实。
4. 产物保存到当前项目允许的 workspace 相对路径，通过现有 `ArtifactPreviewSourceService`/`dascowork-artifact` 生产协议注册并生成可打开的最终链接；E2E 不得直接向 Renderer 注入 sourceId、token、绝对路径或调用预览内部方法。
5. 用 Runtime 的 render/check 脚本把所有 slide 渲染为 PNG，检查 PPTX ZIP/relationships、slide count、文本、图片、越界/重叠、中文字体实际解析结果和 LibreOffice headless open；右侧工作区通过生产文件/preview 路径实际打开同一 SHA 的 PPTX。
6. dev live gate 和 packaged live gate 使用相同 R07 断言。外部模型服务故障只能按现有 suite allowlist 规则整套重跑一次，并分别保留两次证据；不得对 R07 单测加 retry 或放宽断言。
7. 测试在 turn 前记录 workspace 文件清单与 SHA，确认目标 PPTX 不存在；turn 后证明新增 PPTX 由获批 Runtime command 写入。仓库和测试 fixture 静态扫描不得包含可被复制的预生成 `.pptx`。

验收：

- `AT-LIVE-01`：开发版从空 cache 经真实开发 feed 安装 Runtime，真实 AI 生成通过结构和视觉检查的 PPTX。
- `AT-LIVE-PKG-01`：正式安装介质在隔离 userData、无 direct root/override 的条件下完成同一流程。
- 日志中没有 `npm/pnpm/pip install`、搜索私有目录、`officecli`、`python-pptx`、系统 Node/LibreOffice 路径或预生成 PPT copy。
- `expected.json` 中所有 required fact ID 都能在 PPT 提取文本或图表数据中定位，值符合声明的格式化/舍入规则；未声明的市场数字不得被当作输入事实。
- UI artifact、磁盘文件、render verifier 和 evidence receipt 的 PPT SHA 完全一致，最终消息中的链接通过生产 artifact registration 打开该 SHA，而不是测试直接注入。

### P8：把 Runtime feed 与 Presentations 闭环接入发布流水线

涉及文件：

- 修改 [`.github/workflows/desktop-release.yml:92`](../../.github/workflows/desktop-release.yml#L92)
- 修改 [`.github/workflows/desktop-test-plan.yml`](../../.github/workflows/desktop-test-plan.yml)
- 新增 `.github/workflows/primary-runtime-publish.yml`
- 修改 [`electron-builder.yml`](../../desktop-app/electron-builder.yml)
- 修改 [`package.json:14`](../../desktop-app/package.json#L14)
- 修改 release-gate producer 与 evidence verifier

工作项：

1. Runtime build/publish 独立于 Electron build：先生成、验证、签名并发布四目标 Runtime；再让 desktop release candidate 使用确定的 channel manifest sequence。Electron 包仍不内嵌完整 Runtime，但包含 production config endpoint 和公钥。
2. PR 门运行 unit、feed contract、当前平台真实 bundle integration 和 deterministic Electron E2E；protected release 门运行四目标 Runtime build、三平台安装介质 smoke、dev live R07、packaged live R07 和签名/provenance 校验。
3. 每个 release evidence receipt 绑定同一 desktop commit、安装包 SHA、Runtime archive SHA、config/manifest `{sequence,payloadHash,keyId}`、committed activation/plugin generation 和测试报告 SHA。新的 Runtime feed 可独立更新，但必须记录兼容的最小/最大 desktop protocol version 与最低 OS/ABI。
4. 更新 `desktop-test-plan.yml`，不再硬编码旧计划作为唯一范围；本计划的所有 gate 都由 CI 读取实际证据验证。
5. 发布失败关闭：任一目标 Runtime 缺失、manifest 未签名、provenance 不完整、真实 AI 未生成 PPT、PPT 校验失败或证据 SHA 不一致，都不能标记整套架构完成。

验收：

- 完整 release dry-run 在四个平台生成 Runtime、在当前三类桌面安装介质执行对应 smoke，并生成不可手写伪造的 evidence bundle。
- Desktop 安装包不含 Runtime 私钥、开发 CA、测试 fixture、reference-projects 路径、模型凭据或完整 Runtime archive。
- Runtime 服务停机时，已有 last-known-good 用户仍能生成 PPT；首次安装用户得到明确不可用状态，普通聊天仍可用，且客户端不会降级安装替代包。

### P9：最终端到端封板与旧路径清理

涉及文件：

- 删除或降级所有只为旧局部方案存在的重复配置/测试 fixture；具体删除项必须先由引用分析证明无生产调用方
- 更新 [`docs/dasCowork-architecture.md`](../../docs/dasCowork-architecture.md)
- 更新 [`docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md`](../../docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md)
- 更新 [`docs/adr/2026-09-07-app-tools-authenticated-local-ipc.md`](../../docs/adr/2026-09-07-app-tools-authenticated-local-ipc.md)，明确 Pipe 非 Runtime 主链
- 更新 [`desktop-app/README.md`](../../desktop-app/README.md) 与 service/runtime runbook

工作项：

1. 运行引用图，删除已经被 Product Config/Update Coordinator 取代的一次性启动安装分支；保留 direct release/dev root 仅作为明确命名的开发/企业诊断入口，不能在产品默认路径静默触发。
2. 把 `codex-app-tools` 文档改为“兼容投影”，把 Primary Runtime feed/active pointer/capability policy/new-thread 规则写进主架构文档。
3. 做一次 clean-room 演练：新机器、空 cache、只安装 desktop candidate、只提供 production-shaped feed 和正常模型配置，执行 R07 并归档证据。
4. 做一次更新演练：v1 正在被已开始的 turn 使用时发布 v2；进行中的 turn 不被中断，新任务使用 v2；初始无 loader 的 legacy thread resume 得到 `new-thread-required`，已有 loader 的旧 thread 可在 commit 后读取 v2；回滚/坏 v3 不替换 v2。
5. 验证所有禁用路径：移除 `codex-app-tools` MCP、关闭 Native Pipe、清空个人 plugin cache，原生 dynamic tool + Runtime plugin reconcile + live PPT 仍按设计成立。

验收：

- 文档、代码、service contract、CI gate 和用户可见状态使用相同术语与版本。
- 没有第二套 Runtime 真相源、第二套 dynamic tool handler 或测试专用生成路径。
- 最终 evidence bundle 可从 PPT SHA 追溯到 tool call、active bundle、archive、manifest、公钥 ID、provenance 和 desktop commit。

## 6. Acceptance Criteria

以下全部满足才可把目标标为完成：

1. `AC-01`：实现参考证据证明的外部 Runtime config/feed/update/loader 主链，并明确标注本项目增加的签名信任根、防回滚和“不内嵌完整 Runtime”决策；不得把未被参考包证明的签名或绝对无 bootstrap 当作参考事实，也不得退回 local root。
2. `AC-02`：仓库内的开发 HTTPS feed 使用与生产相同的 config/manifest/archive 和 `PrimaryRuntimeHttpClient` 协议；production 只更换部署 origin/keys/TLS policy，不换客户端实现。test CA 不能进入 production、Renderer、app-server 或全局 TLS 状态。
3. `AC-03`：四个发布目标都有真实 Runtime archive、runtime.json、target compatibility、platform-native trust report、provenance、SHA 和组件 smoke，并在最低支持 OS/ABI runner 实际执行。
4. `AC-04`：`@oai/artifact-tool` 与 Runtime plugins 有授权/clean-room 来源；无证明时发布 gate 保持失败。
5. `AC-05`：客户端内置非空、可轮换且按 config/manifest role 限权的公钥和 production origin；私钥不在 desktop/repo/feed 运行进程中，trust state 原子记录 `{sequence,payloadHash,keyId}`。
6. `AC-06`：空 cache、无 Runtime 环境变量时能从签名 feed 完成首次安装。
7. `AC-07`：坏 TLS/签名、错误 key role、未知 key、过期 metadata、sequence rollback、同 sequence 不同 payload、错误 origin/redirect、错误 size/SHA、ZIP 越界和诊断失败均不会改变 committed activation generation。
8. `AC-08`：scheduled update、manual update、repair、cancel、offline、plugin reconcile/readback 失败、pointer commit 失败和 crash recovery 均有逐步骤故障注入证据，last-known-good pointer、Runtime-owned plugin set 和 capability generation 一致可继续执行。
9. `AC-09`：Presentations skill 可用于某次新 turn 时，该 thread 的能力记录证明 loader 已发布，`load_workspace_dependencies` 可调用，且 skill、loader、workspace instructions 指向同一 committed bundle/plugin generation；激活 critical section 不产生混合快照。
10. `AC-10`：missing/installing/broken 状态的 loader 返回结构化诊断；模型没有搜索私有目录或自行安装替代依赖。
11. `AC-11`：Runtime 激活事务完成完整 desired-state plugin reconcile；旧 Runtime-owned plugin 被停用/退役、用户插件不受影响、descriptor 不累积。无 loader 的 legacy thread resume 返回 `new-thread-required`，已有 loader 的 thread 按真实协议工作，不补发或伪造 `dynamicTools`。
12. `AC-12`：关闭/移除 MCP/Native Pipe 兼容链后，原生 `thread/start.dynamicTools → item/tool/call → registry` 仍通过。
13. `AC-13`：deterministic E2E 只 mock 模型 HTTP，其他链路和 Runtime archive 都是真实生产实现。
14. `AC-14`：真实 AI 从 HTML 读取数据，调用 loader，使用 Runtime Node 与真实 artifact-tool，生成至少五类页面的 PPTX。
15. `AC-15`：PPTX 通过 ZIP/relationship、slide count、文本数据、render、overflow/overlap、LibreOffice open 和右侧工作区打开检查。
16. `AC-16`：UI artifact、磁盘 PPT、render report 和 evidence receipt 的 SHA 一致，且能通过 `threadId/turnId/loaderCallId/commandItemId/artifactSourceId` 的有序事件链追溯；不得伪造一个跨 loader 与命令共享的 callId。
17. `AC-17`：dev live 与 packaged live 都通过；fixture、direct root 或组件 smoke 不能替代任一 live gate。
18. `AC-18`：macOS x64/arm64、Windows x64、Linux x64 Runtime 与对应桌面安装介质门禁均通过，包括最低 OS/ABI、code signing/notarization/Authenticode、动态库、中文字体与 clean-machine execution。
19. `AC-19`：本计划新增/修改的 Runtime gates 无失败掩盖型 `.skip`/`.only`/测试级 retry/timeout 放宽/断言降级/test-only bridge/fake artifact-tool/fallback generator；已有合法平台/外部服务 skip 只能出现在带理由、owner 和失效条件的静态 allowlist 中，且不得扩大。
20. `AC-20`：`codex/codex-rs/app-server/**` 无改动，Renderer 无 Runtime secret/root/filesystem 新权限，桌面无第二个 LLM client。

## 7. Verification Steps

### 7.1 参考证据与静态边界

```bash
env NODE_PATH=/Users/nallylin/Documents/code/dasCowork/desktop-app/node_modules \
  npm --prefix desktop-app run reference:chatgpt:validate -- \
  --root /Users/nallylin/Documents/code/dasCowork/reference-projects/codex-electron-26.818.21641-beautified

npm --prefix desktop-app run verify:codex-native-runtime-boundaries
npm --prefix desktop-app run verify:codex-app-server-protocol-contract
npm --prefix desktop-app run verify:real-codex-app-server-contract
npm --prefix desktop-app run verify:bundled-plugins
npm --prefix desktop-app run verify:app-tools-release-gates
```

### 7.2 Runtime producer/feed/client

```bash
npm --prefix primary-runtime test
npm --prefix primary-runtime run build:matrix
npm --prefix primary-runtime run verify:matrix
npm --prefix services/primary-runtime-feed test
npm --prefix services/primary-runtime-feed run test:publish-contract
npm --prefix desktop-app run test:primary-runtime-real
npm --prefix desktop-app run test:primary-runtime:stress
npm --prefix desktop-app run smoke:presentations-runtime
npm --prefix desktop-app run test:e2e:primary-runtime-feed
```

其中 `build:matrix` 在本机只能验证当前目标；四目标完成证据必须来自 CI 对应 runner，不允许交叉编译假装执行验证。

### 7.3 Desktop 基线和全链路

```bash
npm --prefix desktop-app/vendors/codex-app-server-client run qa
npm --prefix desktop-app run lint
npm --prefix desktop-app run typecheck
npm --prefix desktop-app test
npm --prefix desktop-app run test:e2e -- --reporter=line
npm --prefix desktop-app run test:e2e:dev-llm
npm --prefix desktop-app run test:e2e:packaged
npm --prefix desktop-app run test:e2e:release-llm
```

### 7.4 激活事务、插件代际与 thread admission

- 对 activation journal 的 prepare、plugin stage、barrier、pointer commit、plugin generation commit、capability publish、readback 和 cleanup 每一步做故障注入，并在每一步后重启 Main；恢复结果只能是完整旧 generation 或完整新 generation。
- 构造 Runtime v1/v2/v3 各自不同的 plugin desired set，验证升级后旧 Runtime-owned plugin/descriptor 被停用或移除、用户插件保留、Plugin Center 与 app-server catalog readback 一致。
- 覆盖 activation 前无 loader 的 legacy thread、activation 前已有 loader 的 thread、activation critical section 并发启动、activation 后新 thread：分别断言 `new-thread-required`、可读取 committed Runtime、等待/旧 generation、完整新 generation。
- capability-scope 证据必须来自 app-server 已有协议和真实 client adapter；没有原生 per-thread skill filter 时，测试不得伪造 per-thread catalog。

### 7.5 证据审计

- 检查每个 receipt 的 commit、desktop artifact SHA、Runtime archive SHA、config/manifest sequence + payloadHash + keyId、committed activation/plugin generation、threadId、turnId、loaderCallId、commandItemId、artifactSourceId、PPT SHA 和报告 SHA。
- 对 release candidate 运行 `git diff --check`，并确认 `codex/codex-rs/app-server/**`、Renderer secret surface 和测试禁止模式无变化；skip/retry/timeout verifier 只检查本计划变更和显式 allowlist，不误报仓库既有合法条件分支。
- 对失败演练保留 last-known-good active pointer、状态事件和服务访问日志；日志必须脱敏且不含模型凭据、下载 token 或用户 HTML 全文。

## 8. Risks and Mitigations

| 风险 | 影响 | 缓解与硬门槛 |
| --- | --- | --- |
| 无权分发真实 `@oai/artifact-tool` 或 Runtime plugins | 架构能跑但不能合法发布 | 只接受授权制品库或 clean-room 实现；`AT-RT-PROVENANCE-01` 失败关闭，禁止复制参考包或用替代库掩盖 |
| 开发 feed 与生产 CDN 行为漂移 | 本地通过、发布失败 | 两者共享同一协议测试和静态目录布局；production 只替换 origin/keys，客户端不分叉 |
| 开发 CA 泄露到产品或通过全局 TLS 开关绕过校验 | 任何 HTTPS 下载都可能失去身份认证 | Main-only Runtime HTTP client、host/SAN/pin 约束、production 拒绝 custom CA、静态禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0` 和证书忽略分支 |
| 签名 key 泄露、角色混用、同 sequence 内容分叉或轮换错误 | 恶意 Runtime、客户端分裂或全量更新中断 | 离线 signer、config/manifest role 分离、双 key 交叠、撤销演练、`{sequence,payloadHash,keyId}` 防回滚/防 equivocation、私钥不进入服务进程和 repo |
| Runtime 大包下载/解压资源过高 | 主进程卡顿或 OOM | 复用现有流式下载/yauzl 解压、体积上限、磁盘预检、取消、stress gate；下载不阻塞聊天 |
| pointer、plugin set 与 capability revision 部分提交 | skill 可见但依赖缺失，或更新失败后旧 Runtime 失效 | Main-owned activation journal、admission barrier、candidate staging、commit readback、逐步骤补偿/重启恢复；只发布 committed generation |
| plugin cache 与 active Runtime 漂移或历史 descriptor 累积 | skill 指向旧 bundle | Runtime-owned owner/revision、完整 desired-state reconcile、旧 set 停用、descriptor replacement、用户插件隔离 |
| app-server plugin catalog 是全局而不是 per-thread | legacy thread 出现新 skill 但没有 loader | P0 协议证明；无 per-thread filter 时使用全局 committed generation + Main resume admission guard，无 loader 的 legacy thread 强制新建任务 |
| 旧 thread 无法热获得新增技能 | 用户认为安装无效 | loader 在功能启用时始终可诊断；激活后显式提示新建任务，不补发或伪造 resume `dynamicTools` |
| 外部模型非确定性导致 live gate 偶发 | CI 噪声 | deterministic E2E 锁因果链，live suite 只允许现有整套外部故障重跑一次；产物结构/数据/视觉用机器校验 |
| 只在当前 Mac 成功，或下载的可执行文件不受目标 OS 信任 | Windows/Linux 发布后缺依赖，macOS/Windows 阻止执行 | Runtime build 与安装介质 smoke 按最低 OS/ABI runner 分平台执行，验证 code signing/notarization/Authenticode/动态库；缺一个目标即不关闭整体目标 |
| 中文字体不可用或许可不允许分发 | PPT 可生成但正式机排版变化、乱码或溢出 | 字体/回退锁文件与 provenance、许可门禁、四目标 render/overflow smoke 记录实际解析字体 |
| 为快速通过又回到 plugin-only | 再现本次失败 | Stop Condition 和 gate 将 bundle/feed/update/capability/live PPT 绑定；`codex-app-tools` 单独成功没有任何完成状态 |

## 9. 明确不接受的“完成证据”

- `codex-app-tools` 已安装、Pipe 能列出工具或 `load_workspace_dependencies` schema 出现。
- Runtime fixture 创建了空 `@oai/artifact-tool` 目录，或只通过 `app-tools-host.e2e.ts`。
- `DASCOWORK_PRIMARY_RUNTIME_ROOT` 指向开发机已有目录，或 direct release 五元组下载成功。
- `run-presentations-runtime-smoke.mjs` 单独通过。
- scripted model 直接返回假的依赖路径/PPT，测试脚本直接调 registry 或复制预生成 PPT。
- AI 用 `officecli`、`python-pptx`、系统 Node、临时 npm/pip 安装等替代路径生成了一个文件。
- 只在开发版、单平台、单次手动操作或旧缓存下成功。
- 通过修改测试、跳过失败、扩大 timeout、降低断言或增加 test-only 客户端分支获得绿色结果。

## 10. Stop Condition

实施不得在任何中间里程碑停止。只有当 `AC-01` 至 `AC-20` 全部通过、`AT-RT-PROVENANCE-01`/`AT-RT-BUILD-01`/`AT-FEED-01`/`AT-RT-UPDATE-01`/`AT-SKILL-CAP-01`/`AT-E2E-01`/`AT-LIVE-01`/`AT-LIVE-PKG-01` 和三平台门禁都有同一发布候选的可验证证据，且 R07 在开发版与正式安装介质中都由真实 AI 生成并打开 PPTX，才可宣告“参考项目架构已复刻并解决 PPT 无法生成问题”。

如果唯一剩余阻塞是第三方/私有 Runtime 产物授权，则状态必须明确记为“架构实现完成、发布被 provenance 阻塞”，不能改用替代依赖，也不能把目标标为完成。

## 11. 2026-09-09 独立审查补充记录

本轮补充已合并以下要求，后续实施和复审不得删除或弱化：

- 将 active pointer、Runtime-owned plugin desired set 和 capability revision 收敛为带 journal、barrier、readback 与补偿的激活事务。
- 增加旧 Runtime-owned plugin 退役、descriptor replacement 和用户插件所有权隔离，修复当前只安装/启用且历史 descriptor 累积的问题。
- 在 P0 先证明 app-server skill catalog 的真实作用域；无 per-thread filter 时使用 global committed generation + legacy resume admission guard，不伪造协议。
- 将 loader、命令和 artifact 改为不同真实 ID 的有序因果链，补充 HTML expected facts、生产 artifact 注册、预生成 PPT 排除和中文字体验证。
- 增加 Main-only HTTPS trust policy、config/manifest key role、同 sequence 防 equivocation、最低 OS/ABI 与平台原生可执行信任门禁。
- 将 `AC-19` 限定到本计划变更和显式 allowlist，继续禁止测试侧掩盖客户端缺陷，同时不误删仓库既有合法条件分支。
