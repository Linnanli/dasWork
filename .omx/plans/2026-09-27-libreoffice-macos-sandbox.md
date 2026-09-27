# macOS LibreOffice 沙箱兼容构建执行计划

日期：2026-09-27。状态：执行中，当前 P2。面向：按步骤执行的编码模型。

## 0. 先读这一节

目标：Primary Runtime 发布的 `binaries.soffice` 在本项目真实 Codex 受限沙箱中，将 PPTX 转成正确的 PDF；覆盖 macOS Intel 和 Apple Silicon。

路线已经选定：**固定上游源码 + 本仓库小补丁 + 独立 GitHub Actions 构建 + 受限沙箱验收**。先证明小补丁有效，再替换 Runtime 产物。暂不建立长期 LibreOffice fork。

本计划只涉及 macOS。Linux、Windows 维持现有产物，不宣称已验证它们的沙箱行为。反馈卡片、前端 PPT 预览、模型推理链路不属于这次修改范围。

执行原则：

- 按 P0 → P6 顺序，每步通过验收后再进入下一步。
- 不修改 `codex/codex-rs/app-server/`，不修改沙箱策略，不自动改为提权执行。
- 不从 Codex Runtime、参考 Electron 包、开发机 Homebrew 复制二进制到发布产物。
- 不把 Codex 的未知补丁当成已知实现，不承诺一次源码修改就解决全部限制。
- 保留工作区现有修改；开始前记录 `git status --short`，不要 reset、stash 或覆盖他人修改。
- 本地安全编辑与测试可自动继续。远端工作流运行、发布 Release、切换用户已激活 Runtime 需核实已有授权；缺少授权时完成可审核的代码和本地证据，再报告具体缺口。

最终完成条件：两种 macOS 架构的构建、真实受限转换、Runtime 物料验证均通过，并留下可复现证据。只有配置文件、单元测试或沙箱外转换成功不算完成。

## 1. 已知事实与未知项

### 已验证事实

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| 本项目 macOS 使用官方 26.2.6 DMG | `primary-runtime/runtime-sources.lock.json:108`、`:109` | 同一沙箱内两份 PPTX 都 SIGABRT |
| 当前 macOS 直接复制 app bundle | `primary-runtime/runtime-toolchains.lock.json:85`、`:284`；`primary-runtime/scripts/materialize-runtime-inputs.mjs:846` | 没有无头兼容源码补丁 |
| 官方 26.8.0.3 Intel 包 | `/private/tmp/dascowork-lo-26.8-verify/RESULT.md` | 沙箱内退出 1，无 PDF；沙箱外同一输入成功，10 页 |
| 本地通信限制 | 同目录 `sandbox-denials.txt` | `network-bind /private/tmp/OSL_PIPE_501_SingleOfficeIPC_*` 被拒绝 |
| Codex 定制版本 | `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/manifest.json` | 有 sourceRef、patchSha256；沙箱内同一 PPTX 成功，10 页 |
| Codex 包装脚本 | `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice:4` | 提供独立用户目录，没有放宽沙箱 |
| 现有 Runtime 渲染检查不是沙箱证据 | `primary-runtime/scripts/verify-runtime-inputs.mjs:497` | 普通子进程转换 |
| 现有真实 feed E2E 使用提权 | `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:787` | `sandbox_permissions: 'require_escalated'`，不能证明本任务通过 |

行号会随代码变动，执行时用函数名/字段名重新定位。

本机测试输入：`/Users/nallylin/Documents/code/test2/ai-agent-security-market.pptx`，SHA256 `fdfbc12d09939c031a3e9e11eba8d40e5181d34deda15f117dca7665b13e79cd`。它只能作本机补充测试，不得未经许可放入仓库或公开 CI artifact。

仓库已有可用于 CI 的输入：`desktop-app/tests/e2e/fixtures/artifact-presentation.pptx`。需检查实际页数/内容后锁定断言，不能把所有输入都硬编码为 10 页。

### 源码依据

固定研究基线为上游 `libreoffice-26.8.0.3`，解析并记录不可变 commit 和源码归档 SHA256 后才能构建：

- [macOS 发行配置](https://github.com/LibreOffice/core/blob/libreoffice-26.8.0.3/distro-configs/LibreOfficeMacOSX.conf)：已启用 `--enable-headless`、内置 fontconfig/freetype。
- [officeipcthread.cxx](https://github.com/LibreOffice/core/blob/libreoffice-26.8.0.3/desktop/source/app/officeipcthread.cxx#L632)：`RequestHandler::Enable(bool ipc)` 支持 `ipc=false`；普通桌面路径会创建用于实例协调的 pipe。
- [app.cxx](https://github.com/LibreOffice/core/blob/libreoffice-26.8.0.3/desktop/source/app/app.cxx#L497)：启动调用 `RequestHandler::Enable(true)`；pipe 错误作为启动错误处理。

未知：Codex 补丁正文、是否还有其他必要修复、ARM64 实际表现、构建耗时。socket 拒绝是已观察到的障碍，尚未通过单变量源码实验证明它是唯一障碍。

## 2. 设计决定

采用仅用于本项目转换进程的**显式关闭实例通信开关**，保持普通 LibreOffice 默认行为。

建议开关：`-env:DASCOWORK_HEADLESS_NO_IPC=1`，用 LibreOffice 已有 bootstrap 变量机制读取；读取 API 和 `IsHeadless()` 名称必须在固定源码中确认后实现。

预期逻辑（伪代码，不能原样粘贴当已编译代码）：

```text
仅在 macOS 编译目标：
    optIn = bootstrap("DASCOWORK_HEADLESS_NO_IPC") == "1"
    disableIpc = optIn && commandLine.isHeadless()
其他平台：
    disableIpc = false
RequestHandler::Enable(!disableIpc)
```

必须满足：

- 无开关时保持上游行为；只有开关而没有 `--headless` 时仍保持上游行为。
- 不全局定义 `HAVE_FEATURE_MACOSX_SANDBOX`，该宏影响其他平台行为，不能当成单项 IPC 开关。
- 不通过捕获所有启动错误后继续执行来掩盖问题。
- 保留用户目录锁、文档锁和错误处理；每个任务使用独立用户目录。
- 使用 Runtime 统一入口传入开关，覆盖 agent、presentation skill、Main 预览三种调用方。
- 不增加第三方依赖。优先复用现有脚本、锁文件、校验工具。

## 3. 文件范围

现有需阅读/可能修改：

| 文件 | 用途 |
| --- | --- |
| `primary-runtime/README.md:4` | 可信来源约束 |
| `primary-runtime/runtime-sources.lock.json:108` | macOS 产物来源、版本、SHA256 |
| `primary-runtime/runtime-toolchains.lock.json:85` | Intel 解包配置、输出及 native closure |
| `primary-runtime/runtime-toolchains.lock.json:284` | ARM64 对应配置 |
| `primary-runtime/scripts/materialize-runtime-inputs.mjs:648` | 源码构建和物料集成；优先复用现有归档解包 |
| `primary-runtime/scripts/verify-runtime-inputs.mjs:70` | native closure 验证，不能拿 shell 当 Mach-O |
| `primary-runtime/scripts/verify-runtime-inputs.mjs:497` | 中文演示转换检查 |
| `primary-runtime/tests/runtime-inputs.node-test.mjs` | 物料/锁定回归测试 |
| `.github/workflows/primary-runtime-build.yml:246` | 现有平台矩阵与验证集成 |
| `desktop-app/src/main/artifacts/PresentationArtifactPreviewService.ts:65` | 消费 `dependencies.binaries.soffice`，通常无需改业务逻辑 |
| `desktop-app/tests/e2e/primary-runtime-feed.e2e.ts:787` | 新增受限路径验证，保留现有测试的原有含义 |

拟新增（先确认仓库不存在等价文件）：

- `primary-runtime/patches/libreoffice-macos-headless-no-ipc.patch`
- `primary-runtime/libreoffice-build.lock.json`：源码、构建依赖、patch、工具链的不可变标识。
- `primary-runtime/scripts/build-libreoffice-headless.mjs`
- `primary-runtime/scripts/verify-libreoffice-sandbox.mjs`
- `primary-runtime/tests/libreoffice-headless.node-test.mjs`
- `.github/workflows/libreoffice-headless-build.yml`
- `docs/verification/libreoffice-macos-sandbox.md`：事实、复现命令、验收报告链接。

锁文件字段应由实现定义并校验，不要假装上述新文件已有 schema。上游构建元数据与 Runtime 下载产物锁定是两层记录，需通过 SHA256 关联。

## P0. 固化基线与证据

操作：

1. 阅读 AGENTS.md、相关脚本和 schema，记录当前工作区状态。
2. 将临时验证结果整理到 `docs/verification/libreoffice-macos-sandbox.md`；临时文件不存在时重跑，不制造成功记录。
3. 为沙箱验证定义报告字段：平台/架构、源码与二进制 hash、sandbox 类型/配置来源、命令参数、退出码、耗时、输出页数、文本检查、日志、是否发生提权。
4. 使用仓库 fixture 建立基线；旧包受限失败、候选包后续受限成功要可比较。

验收：报告能区分“沙箱外”“真实 app-server 受限模式”“本机 Codex 工具沙箱”；不能互相冒充。未测试状态明确标记。

## P1. 编写并审查最小补丁

操作：

1. 获取固定源码至工作区忽略的构建目录，核验 hash，不使用浮动 master/latest。
2. 回查 `Desktop::Init`、命令行 headless 检查、bootstrap API、`RequestHandler::Enable(false)` 的完整后续调用，确认禁用 IPC 后命令请求仍被执行。
3. 按第 2 节实现显式开关；patch 必须可 `git apply --check`，禁止模糊匹配或失败后继续。
4. 更新构建锁中的 patch SHA256。定义默认、开关+headless、只有开关三种行为测试，P2 构建完成后执行；此阶段先通过 patch 应用和分支审查，不能只验证源码包含字符串就声称行为通过。
5. 记录补丁行为与限制，不标记为 Codex 官方补丁。

验收：补丁仅作用 macOS 显式选择的 headless 流程。若无法证明 `Enable(false)` 下仍能完成任务，停在本步骤报告具体调用链，不扩散重构。

## P2. 独立构建并做单架构实验

操作：

1. 实现构建脚本；输入 target、构建锁、输出目录，严格校验 target 与宿主架构。
2. 构建使用完整 Xcode、固定 SDK/编译器；先检查本机条件。当前机器此前仅发现 Command Line Tools，不能假装本机已能构建。
3. 基于上游 macOS 发行配置启用 headless 与内置字体依赖；保留 Impress/PPTX 导入和 PDF 导出。
4. 上游外部源码包也要校验其锁定摘要，记录实际下载清单；不能仅锁主仓库而忽略构建依赖。
5. 若必须依赖 GitHub runner 才可编译，此阶段只建立最小手动编译 job；通过实验后在 P4 完善发布流程，不要求本机先编译成功。
6. 同一个自编译二进制，用独立 profile 分别测试开关关闭、开启；加入官方 26.8 对照。所有关键转换在同一受限策略下运行。

验收：开关开启可转换；关闭时的表现如实记录。若开启仍失败，收集 stderr、退出码、系统拒绝日志；只针对新证据修复，不关闭整个沙箱。单架构通过仅允许进入后续实现，不算最终通过。

## P3. Runtime 统一入口与字体

操作：

1. 在最终包中放置固定入口 wrapper，由 `binaries.soffice` 指向它；实际 Mach-O 另保留原路径。
2. wrapper 默认传入显式 IPC 开关；调用者仍必须传 `--headless` 才生效。
3. 没有 `-env:UserInstallation=` 时创建唯一 profile，有明确 profile 时保留调用者值。正确处理带空格路径和参数数组，不拼 shell 字符串。
4. 自己创建的临时目录在退出/信号时清理；不删除调用者 profile。保持退出码、stderr，确保取消/超时能清理子进程。
5. fontconfig 指向 Runtime 自带字体和本次任务可写缓存；不要依赖开发机 `/opt/homebrew`、`/usr/local` 或用户字体。HOME/XDG 使用隔离目录时不得破坏配置和输入路径解析。
6. 单元测试用假子进程验证参数、清理、信号、退出码和路径含空格；真实转换验证另做，不能相互替代。
7. closure 检查继续对真实 Mach-O/dylib 运行；不得为了 wrapper 跳过所有 native 校验。

验收：agent 返回的 soffice 路径、skill 调用和 Main 预览均落到统一入口；两个并行任务各自产出有效 PDF，互不复用进程、配置或输出。

## P4. 完成独立 GitHub Actions 流水线

操作：

1. 工作流支持 `workflow_dispatch`，可复用 `workflow_call`；默认不发布 Release。
2. 使用原生 Intel/ARM64 两个 job，runner 标签参考现有 workflow，并在执行时检查 `uname -m`，不要凭标签推断架构。
3. 权限默认 `contents: read`；构建与发布分离。第三方 actions 固定可信 commit，遵循仓库现有约定。
4. 缓存 key 包含 target、源码 ref、patch hash、工具链/SDK/配置摘要。缓存命中也必须完成产物验证。
5. 输出每架构归档、SHA256、LICENSE/NOTICE、源码/patch/依赖/工具链记录及测试报告；保持签名与 native closure 验证要求，不把签名问题自动忽略。
6. GitHub 托管 job 限制 6 小时；先测耗时。超限时报告需更大 runner/自托管，不无限重试或伪报成功。
7. 在 runner 上运行 P5 验证。测试环境无真实沙箱执行能力时标记未验证，不能自动通过发布门禁。

验收：两架构 job 有独立证据；产物不依赖构建机残留目录，换一个目录解包仍可运行。下载 URL 不可变；正式发布和上传受授权控制。

## P5. 真实受限沙箱验收

先实现以下断言，再把结果接入 CI/Runtime 发布检查：

- 使用当前安装 Codex 的 `sandbox --help` 或本项目真实 app-server 配置确认调用方式，不照抄旧版本 CLI 语法。
- 不自行生成“看起来像沙箱”的宽松策略代替实际策略；不允许 Unix socket 特例来让测试通过。
- 沙箱配置含正常工作区读写权限，网络限制保持本项目默认。记录有效配置与命令。
- 增加沙箱生效探针：在沙箱允许的临时目录创建 AF_UNIX socket 应被策略拒绝；若探针成功，该次结果不满足本任务的严格受限验收条件。
- 如果测试驱动在沙箱外启动受限子进程，单独记录二者权限；子进程的实际受限证据必不可少。
- 每次使用全新输出/profile。转换超时 60 秒即失败，退出码必须 0；输出 PDF 存在且非空，`pdfinfo` 页数与输入一致。
- `pdftotext` 能提取锁定的中文标题；`pdftoppm` 生成全部页面，人工检查全部缩略图和首/中/末页，不能只检查文件存在。
- 确认日志里没有同进程新建 `SingleOfficeIPC` socket 被拒绝；允许无关警告但要说明依据。
- 至少：串行转换 2 次 + 并行 2 任务；正常退出后无残留转换进程，临时目录按约定清理。
- 检查 `--version`、损坏输入、不可写输出、超时/取消；错误必须被上层识别，不能仅凭 LibreOffice exit 0 判断成功。
- 清空或隔离 fontconfig 缓存重新验证一次，使用 Runtime 字体。
- 两种 macOS 架构都通过；本地 `test2` 的 10 页 PPTX 作附加验收。

保留现有沙箱外 E2E；新增明确的受限 E2E 断言，不把原有全部 `require_escalated` 粗暴替换掉。fake provider 可以驱动工具调用，但实际命令必须经过真实 app-server 沙箱。

验收报告必须包含失败结果，不能只上传成功日志。源文件和内容若来自用户项目，不得上传公开 CI。

## P6. 接入 Primary Runtime 与交付

前置条件：P5 两架构全部通过，产物已有可信不可变下载位置。

操作：

1. 修改 macOS 两条 `runtime-sources.lock.json` 记录为自建产物 URL/version/SHA256；关联源码 ref、patch hash、构建证明。不能填写占位 checksum。
2. 更新 `runtime-toolchains.lock.json` 的归档类型、sourceDirectory、distribution、outputs、closure；tar 产物走已有 tar 解包，不继续走 DMG 分支。
3. 使用现有 provenance/schema 校验，必要时最小扩展并补测试；不要绕过 source lock 检查。更新实际要求的 builder/materialization 版本并重新生成 inputs。
4. 确认 Main 与 skill 只消费新路径即可；若不得不修改调用方，限定为参数/环境兼容，不改 UI。
5. 对下列命令先确认 scripts 仍存在，再运行；新脚本的 CLI 参数需写入 README 并用已实现的真实命令补全验证记录。

```sh
npm --prefix primary-runtime test
node --test primary-runtime/tests/runtime-inputs.node-test.mjs primary-runtime/tests/build-runtime.node-test.mjs
npm --prefix desktop-app run typecheck
npm --prefix desktop-app run lint
npm --prefix desktop-app run verify:bundled-plugins
npm --prefix desktop-app run verify:app-tools-release-gates
npm --prefix desktop-app run smoke:presentation-skill-runtime
```

还必须运行：真实新物料的 `materialize:inputs`、`verify:inputs`、`build`、`verify`，新受限 E2E，以及受影响 Main 预览测试。参数依据脚本解析与当前 output root填写，禁止把缺参失败当环境故障跳过。

未改 desktop 代码时仍需证明现有消费者兼容；无需无目的地重复全量 E2E。若改了 shared/preload/Main API，重新评估范围，不能静默扩展。

交付：构建/验证文档、锁定产物、补丁、workflow、回归测试及失败说明。提供回滚方式：恢复上一个可信 source/toolchain lock 并重建；不删除用户已安装 Runtime，不自动切 active pointer。旧版回滚仍有已知沙箱问题，应写明。

## 4. 阶段状态表（执行时更新）

| 阶段 | 状态 | 证据路径/运行编号 | 未完成原因 |
| --- | --- | --- | --- |
| P0 基线 | 通过 | `docs/verification/libreoffice-macos-sandbox.md`；`/private/tmp/dascowork-lo-26.8-verify/`；`/private/tmp/dascowork-lo-worktree-status-20260927.txt` | 历史结果仅为 Codex 工具沙箱，不是 app-server 受限 E2E |
| P1 最小补丁 | 通过 | `primary-runtime/patches/libreoffice-macos-headless-no-ipc.patch`；`primary-runtime/libreoffice-build.lock.json`；`docs/verification/libreoffice-macos-sandbox.md`；固定源码上 `git apply --check` 通过 | 编译与三种行为实验属于 P2，尚未运行 |
| P2 单架构实验 | 进行中 | `primary-runtime/scripts/build-libreoffice-headless.mjs`、`verify-libreoffice-sandbox.mjs`；`.github/workflows/libreoffice-headless-build.yml`；`docs/verification/libreoffice-macos-sandbox.md` 记录 CI 及官方包受限对照；本机 Xcode preflight 失败 | 本机只有 Command Line Tools；远端尚无成功构建产物，候选包受限转换未运行 |
| P3 统一入口 | 未开始 | | |
| P4 双架构流水线 | 未开始 | | |
| P5 受限验收 | 未开始 | | |
| P6 Runtime 接入 | 未开始 | | |

状态只用：未开始、进行中、通过、失败、受外部条件阻塞。代码写完不等于通过。

## 5. 失败时怎么做

| 情况 | 下一步 | 禁止 |
| --- | --- | --- |
| patch 无法应用 | 校验源码 ref，重新定位固定版本函数 | 忽略 patch 错误 |
| 编译缺 Xcode/依赖 | 补齐已授权工具链或使用 CI | 拷贝 Codex 二进制充数 |
| 关闭 IPC 后仍退出 1 | 记录新的系统拒绝/启动日志，缩小原因 | 关闭沙箱、吞掉所有异常 |
| 中文空白/乱码 | 检查 Runtime fontconfig/字体/缓存 | 只检查 PDF 大小就通过 |
| ARM64 未运行 | Intel 结果标为部分完成 | 推断 ARM64 也成功 |
| CI 需要凭据/发布授权 | 完成未受阻代码与文档，列出确切操作 | 自动公开用户文件或发布产物 |
| 需要修改 app-server | 说明协议/能力边界并交回 | 违反仓库禁改规则 |

## 6. 给执行模型的起始指令

> 阅读 AGENTS.md 和本计划。按 P0 至 P6 执行，先做最小可证实补丁，不重新讨论已选定的整体路线。每完成一步更新状态表及证据。保持当前沙箱限制，禁止以沙箱外成功、mock 测试或未运行的 GitHub YAML 代替真实修复。无法完成双架构真实验证时，明确列出缺口，不声称任务完成。当前只授权计划文档生成；后续实施以用户交给你的执行指令为准。
