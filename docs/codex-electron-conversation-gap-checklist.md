# Codex Electron 对话能力差距清单

> 对照对象：`reference-projects/codex-electron-26.818.21641-beautified`
>
> 目标：把参考项目中已经出现、但 dasCowork 尚未完成的对话能力整理为可长期维护、可逐项验收的开发清单。

## 使用规则

- `P0`：直接影响任务能否连续、可靠地完成，应优先处理。
- `P1`：显著提高任务管理和协作效率，在 P0 稳定后处理。
- `P2`：平台型增强，不阻塞核心工作流。
- 状态分为：
  - **缺失**：当前没有用户入口，也没有完整桌面接口。
  - **部分实现**：已经能展示部分信息，但无法继续操作或存在关键缺口。
  - **入口缺失**：底层接口已经存在，主要缺少界面接入。
- 完成一个条目前，至少满足该条目的全部验收条件，并补充对应的单元测试或端到端测试。

## 实施边界

- 禁止修改 `codex/codex-rs/app-server/`。
- 不得绕过 Codex app server 直接调用模型接口。
- Renderer 只能通过 preload 暴露的白名单 API 使用桌面能力。
- 涉及 thread、turn、approval、sandbox、worktree、MCP 或 tools 时，先判断改动应该位于：
  - `desktop-app/src/renderer/`
  - `desktop-app/src/preload/`
  - `desktop-app/src/main/`
  - `desktop-app/vendors/ai-sdk-provider-codex-asp/`
- 参考目录是发布包排版后的代码，只能用于行为分析，不能直接复制为项目源码。

## 已有能力基线

以下能力已经存在，不应作为“全新缺失能力”重复建设：

- [x] 多会话切换，以及运行中、未读、需处理状态。
- [x] 草稿和会话滚动位置恢复。
- [x] 图片、文件、文件夹附件。
- [x] `@` 搜索文件、任务、Agent、Skill、Plugin、App 和工具。
- [x] Markdown、代码、数学公式、Mermaid 和推理过程展示。
- [x] 工具调用、MCP、Web 搜索、计划和子 Agent 活动的内联展示。
- [x] 命令、文件改动、MCP 审批以及自由文本问答。
- [x] 用户消息编辑、助手消息复制和耗时展示。
- [x] 文件改动摘要、补丁预览和打开本地文件。
- [x] 生成图片与任务结束资源卡片。

主要证据：

- [当前对话输入与消息界面](../desktop-app/src/renderer/src/App.tsx)
- [当前渲染能力矩阵](../desktop-app/src/renderer/src/lib/renderUnitCapabilityMatrix.ts)
- [当前审批面板](../desktop-app/src/renderer/src/components/assistant-ui/server-request-panel.tsx)
- [当前子 Agent 展示](../desktop-app/src/renderer/src/components/render-units/subagentActivity.tsx)

---

## P0：核心连续性和可靠性

### P0-01 运行中追问队列与 Steer

- [x] Agent 运行中仍可输入；空输入显示 Stop，有内容显示 Queue/Steer。
- [x] Queue/Steer 默认模式可持久保存，反向快捷键只影响本次提交。
- [x] Queue 支持编辑、删除、键盘/拖拽排序、立即发送、失败重试。
- [x] Steer 直接使用 app-server `turn/steer`，携带 `expectedTurnId` 和稳定消息 id。
- [x] 未被 app-server 接受的 Steer 必须恢复到队首，不能丢失或静默变成新 turn。
- [x] main 按会话持久化队列并提供唯一发送租约，刷新、重启和多窗口下不丢、不重发。
- [x] 自然完成后自动处理队首；用户中断后队列暂停，显式恢复后才继续。
- [x] 失败项阻塞队首；后续项不得越过；崩溃后的不确定项不得自动重发。
- [x] 队列保存不可变的文本、图片、文件、文件夹、任务引用和 `@` 上下文快照。
- [x] 附件在发送时重新校验，并在成功、删除和会话清理时释放持久资源。
- [x] main 在发出终态事件前完成 active-run 清理；终态和队列调度均幂等。
- [x] Steer 的乐观消息与实时/历史消息按稳定 id 合并，切换会话后不重复。
- [x] 审批、结构化提问、归档、local id → thread id 迁移均有明确队列行为。
- [x] 所有队列操作支持键盘与屏幕阅读器反馈。
- [x] 单元与端到端测试覆盖 Queue、Steer、竞态、中断、恢复、失败、附件失效、刷新、重启、会话切换和重复事件。

状态：**已实施（2026-07-18）**

实现证据：

- [运行中 Queue/Steer Composer 与队列交互](../desktop-app/src/renderer/src/App.tsx)
- [持久队列、租约、暂停与恢复](../desktop-app/src/main/followUps/ConversationFollowUpQueueService.ts)
- [持久附件与崩溃回收](../desktop-app/src/main/followUps/FollowUpAssetStore.ts)
- [权威终态与精确 active session](../desktop-app/src/main/codexChatRuntimeService.ts)
- [provider `turn/steer` 实现](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/session.ts)
- [Queue/Steer Electron 端到端测试](../desktop-app/tests/e2e/follow-up-queue-steer.e2e.ts)
- [P0-01 可靠性与实现计划](../.omx/plans/p0-01-running-follow-up-queue-steer-plan.md)

参考证据：

- [队列编辑、删除、排序、立即发送和恢复](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/queued-message-list-D_Xh6IzQ.js#L115)

### P0-02 活跃任务重连与局部恢复

- [x] Renderer 刷新后可从 main-owned 基础消息快照恢复并重新连接仍在运行的任务；对明确的 app-server 传输断开会在 750ms 后自动重连一次，未知或不安全的恢复失败不会盲目重试。
- [x] 无法恢复时明确显示安全原因，不把任务误报为已完成；复杂快照恢复仍待补齐。
- [x] 单条回复渲染失败时可局部重试，不需要重新加载整个会话。
- [x] 重新连接失败时展示可操作的安全诊断；运行中 app-server 的 existing-turn resume 已通过 provider/main 专用恢复接入，child 重启缺失 active turn 时安全收敛为 interrupted。
- [x] worktree 丢失、被清理或初始化失败时提供恢复、重试或本地继续选项：恢复契约、main-only 恢复、UI 和 P0-03 的 managed-worktree 元数据写入已完成；Electron E2E 已在真实临时 Git 仓库中验证创建、删除和恢复。
- [x] 页面销毁不会无条件终止仍应后台运行的任务。
- [x] 覆盖刷新、重连、app-server 重启、恢复失败和重复事件场景的测试；已执行 21 项专项 Electron/Playwright 用例，并以 `--repeat-each=3` 完成稳定性回归；单元测试额外锁定明确传输中断的一次自动重连与未知失败不重试。

状态：**已实现（2026-08-28）**

本轮恢复审查已补上 attach/replay 的失败契约：run 消失、runId 不匹配、journal 无法补发和未确认的静默关闭都明确进入 `needs_resume`，不会再被转换成完成；provider/main 只读取稳定错误码恢复同一 active turn。P0-03 已完成 managed-worktree 的创建、元数据写入与真实恢复闭环，因此 P0-02B 也已验收。

已实现边界：

- [MessagePort 丢失只 detach，不再取消底层 turn](../desktop-app/src/main/codexChatRuntimeService.ts)
- [Stop 控制消息以 runId 精确校验，重新附加端口也可安全取消当前 run](../desktop-app/src/main/codexChatRuntimeService.ts)
- [Main 保留活跃 turn 的事件日志，并允许新 MessagePort 附加和回放](../desktop-app/src/main/codexChatRuntimeService.ts)
- [Main 在终态后保留五分钟只读 journal，供断线 renderer 重放](../desktop-app/src/main/codexChatRuntimeService.ts)
- [preload/transport 通过白名单 IPC 查询并重新附加活跃会话](../desktop-app/src/preload/chatStreamBridge.ts)
- [Registry 销毁只清理 renderer 本地状态](../desktop-app/src/renderer/src/runtime/ConversationChatRegistry.ts)
- [刷新后在同一 provider 请求内接收后续 live delta 的 E2E](../desktop-app/tests/e2e/fault-injection.e2e.ts)
- [刷新后文本与同一工具调用各只恢复一次的 E2E](../desktop-app/tests/e2e/approvals.e2e.ts)
- [会话打开立即读取历史，再附加仍在运行的任务](../desktop-app/src/main/conversations/ConversationApiService.ts)
- [刷新后从 pending approval 快照恢复同一 requestId](../desktop-app/src/main/codexApprovalBroker.ts)
- [单个 render unit 的本地错误边界与“重试渲染”](../desktop-app/src/renderer/src/components/conversation/ConversationTurnErrorBoundary.tsx)
- [恢复失败分类、无障碍提示和一次短暂故障自动重试](../desktop-app/src/renderer/src/runtime/classifyConversationRecoveryError.ts)
- [provider/main 的同一 active turn 专用恢复：`thread/resume` snapshot 合并且不新增 `turn/start`](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/model.ts)

仍缺失：

- [renderer 持久 sequence 游标](../desktop-app/src/renderer/src/lib/ElectronIpcChatTransport.ts)；端口现在携带 `runId + sequence`，preload 会在短断线后以最后确认的序号自动 attach 一次，并去重、拒绝缺序和在 journal 溢出时显式要求重新同步。
- [managed-worktree 恢复元数据与状态](../desktop-app/src/shared/projects/projectTypes.ts) 已由 P0-03 在创建 worktree 时写入，并由 [Main-only 创建服务](../desktop-app/src/main/conversations/ManagedWorktreeService.ts) 管理。
- P002-E2E-01 已证明在 `thread/start` 尚未返回时刷新仍能以 local conversation ID 从 main snapshot 恢复原始用户消息、附加同一 run，且不会新增 provider 请求；P002-E2E-02 已证明已绑定任务在文本和 pending tool 同时存在时刷新，文本、approval panel、最终回复和同一 tool output 都只恢复一次；P002-E2E-03 已在不刷新页面的条件下触发 MessagePort `messageerror` 并自动 attach；P002-E2E-04 已证明可补齐的 sequence gap 从 main journal 按序重放，且 transcript 不重复；C22 已证明绑定后的刷新可重新订阅同一活跃流并接收后续 delta；P002-E2E-05 已证明 detach 期间 completed、failed 与用户 Stop 产生的 aborted/interrupted 终态能正确恢复（失败保留部分内容并显示 error；interrupted 不重复渲染 assistant 终态卡），P002-E2E-08 已证明审批刷新恢复。P002-E2E-06A 已保持真实 app-server child 存活并重建 desktop-facing transport，确认同一 active turn 和无第二个 `turn/start`；P002-E2E-06B 已重启 child，确认保留历史、显示 interrupted，且不自动 replay；P002-E2E-09 已验证局部 Error Boundary 的浏览器降级与重试不重放 turn。P002-E2E-07 已验证未知 IPC 恢复错误不会泄露原始文本，且已显示文本会保留并进入不可自动恢复状态；稳定错误码的分类由分层单元测试覆盖。P002-E2E-10 已验证工作区状态矩阵的 UI 动作白名单；P002-E2E-11 已在真实临时 Git 仓库中创建受管 worktree、将其删除后经 Renderer → preload → Main 恢复，并重新校验 worktree 根目录和分支。专项 Electron/Playwright 用例已覆盖真实受管 worktree 的创建、丢失与恢复闭环。

开发计划：

- [P0-02 活跃任务重连与本地恢复开发计划](../.omx/plans/p0-02-active-task-reconnect-and-local-recovery.md)

参考证据：

- [单轮渲染失败重试](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L13296)
- [任务重连状态](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L14390)
- [worktree 恢复](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L12470)

### P0-03 从任意消息继续与任务分叉

- [x] 历史助手消息可从其精确 app-server turn 创建新的任务分支。
- [x] 可选择在当前工作区创建任务、创建独立本地 Side task 或在新的 Git worktree 中继续。
- [x] 新任务先完整复制，再只在副本中回退所选 turn 后的步骤；回读校验失败时不会导航到错误历史。
- [~] Side task 会独立运行且不打断主任务；当前 app-server 的 `thread/rollback` 不支持 ephemeral 副本，因此它暂时会保留为普通独立任务，不能诚信地标为“临时”。
- [x] 主任务与分叉任务的 thread id 不同，运行、审批和未读状态由既有 registry/broker 分别管理。
- [x] 非本地或非 Git 工作区会在创建前显示明确原因；Git worktree 的创建、元数据写入和恢复路径均仅在 Main 执行。
- [x] 已覆盖协议转发、历史截断校验、Side task、Git worktree 创建/清理、受管工作区解析和 Renderer 入口；Electron E2E 已验证历史回复入口可见、preload/Main 分叉、仅回退副本和原任务不变，并在临时 Git 仓库中验证 app-owned worktree 的创建与路径隔离。

状态：**部分实现（2026-08-27）**

实现证据：

- [历史回复的“从这里继续”菜单与独立任务入口](../desktop-app/src/renderer/src/App.tsx)
- [shared schema、preload 白名单与 Main IPC](../desktop-app/src/shared/codexIpcApi.ts)、[preload](../desktop-app/src/preload/index.ts)、[Main](../desktop-app/src/main/index.ts)
- [仅在新副本上执行 fork/rollback 并验证保留历史](../desktop-app/src/main/conversations/AppServerThreadClient.ts)
- [分叉任务的项目/工作区状态复制](../desktop-app/src/main/conversations/ConversationForkService.ts)
- [Main-only Git worktree 创建与失败清理](../desktop-app/src/main/conversations/ManagedWorktreeService.ts)
- [受管 worktree 以自身目录作为唯一可写根](../desktop-app/src/main/projects/ProjectService.ts)
- [provider history RPC](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/history-client.ts)
- [历史步骤分叉的隔离 Electron E2E](../desktop-app/tests/e2e/conversation-fork.e2e.ts)

协议限制：

- `thread/rollback` 在当前 app-server 中仍可用，但已声明为 deprecated，且没有 capability 协商。调用失败或被移除时会明确失败，不会伪造“从此处继续”成功。
- app-server 的 ephemeral fork 没有可安全回退的持久 rollout；要实现真正临时的旧 turn Side task，需要上游提供带 target turn 的 fork 协议。

参考证据：

- [从旧消息继续](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L12740)
- [Side task 与 Continue in](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-overflow-menu-Co-VIJCM.js#L612)

### P0-04 本地 Git 改动审核与恢复

- [x] “撤销”和“审核”已是真实操作；审核打开改动审核面板，turn 卡片仅在完整成功撤销后切换为“重新应用”。
- [x] 改动审核面板提供文件树、文件级 diff、增删统计、刷新、加载、空、失败、过大 diff 和过期快照状态。
- [x] 改动审核面板的数据源已区分未暂存、已暂存、指定提交、当前分支相对基准分支和上一个 turn；不混入任意自定义 diff 范围。
- [x] 改动审核面板支持对全部改动、单个文件或单个 hunk 暂存、取消暂存和恢复；已暂存恢复先处理 index，再处理工作区，并报告完整成功、部分成功、跳过和冲突路径。
- [x] turn 级撤销只使用本 turn 的 patch batches，并按目录逆序恢复、成功后可重新应用；Renderer 仅在可信 Git target、完整 patch batches 与已完成 turn 均已就绪时启用操作，Main 仍会逐 batch 验证 cwd 与 Git 根目录。
- [x] 按参考项目策略，Review 写操作在写入前重新读取 revision；turn 撤销／重新应用由 `git apply` 的 applied、skipped、conflicted 结果处理漂移和冲突，不额外逐文件 revision 对照。
- [x] 普通恢复有首次确认和“不再询问”；确认时冻结最初选择的 target、source、snapshot generation、section/file/hunk 范围、文件路径（含旧路径）及 revision。确认框沿用参考项目的通用文案，不重复展示范围。
- [x] Review patch 写后会合并 applied、skipped、conflicted 路径并仅刷新相关文件；写入结果未提供路径时使用冻结的 patch 文件目标（含重命名前路径）兜底，文件监听提供 changedPaths 时同样定向刷新。
- [x] Codex Review 与 Git diff 面板分开；仅支持审核未提交改动或相对基准分支的改动，并可在当前会话或独立会话中复用普通聊天链路和 `::code-comment` 结果。
- [x] 支持本地分支搜索、创建和切换；切换被未提交改动阻塞时会列出受影响文件与增删统计，并在提交后重试原操作，不暴露 stash UI。
- [x] 本地 Git 读取和写入只在 Main process 专用服务中执行，经 shared schema 和 preload 白名单暴露给 Renderer；未修改 Codex App Server，也不依赖远端仓库、GitHub 账号或 GitHub CLI。
- [x] Review、turn、分支创建/切换和“提交后重试切换”均使用全局 Git 操作反馈；分支列表、阻塞文件和可重试错误仍保留在对应交互中，“提交后重试切换”按 `hostId + cwd` 维护单一进行中阶段，避免同一仓库重复提交。
- [x] 覆盖非 Git 目录、空仓库、未跟踪文件、重命名、复制、类型变化、二进制文件、submodule/gitlink、工作区漂移、过期快照、分支切换阻塞、冲突和部分恢复失败场景的单元、组件和 Electron E2E 测试。

状态：**完成（13/13 条完成）**

本次更新：Review、turn 和分支/提交终态统一使用 Git Review Provider 提供全局、可关闭且辅助技术可读的提示；保留局部 pending、错误和阻塞恢复交互，并让提交后重试按仓库串行，不新增依赖。新增 P004-EDGE-01 至 P004-EDGE-13 覆盖契约，以真实 Git 临时仓库、组件状态和五类 Electron 流程追踪全部边界场景。

范围边界：

- 本项只负责本地工作区的改动查看、Codex Review、本地分支操作和安全恢复。
- `push`、发布分支、创建 PR、CI、评论、reviewer、合并冲突和 GitHub 页面跳转不属于 P0-04，统一由 P1-07 负责。
- GitHub 插件、GitHub App/Connector 和 GitHub CLI 都不是完成本项的前置条件。
- App Server 的 `review/start` 不是参考项目这条 Codex Review 交互的实现前置；本项沿用普通 `turn/start`，不扩展或修改 App Server。

当前证据：

- [工作区 Review 标签与打开 Review 面板](../desktop-app/src/renderer/src/components/workspace-container/WorkspaceTabStrip.tsx#L73)
- [turn 撤销／重新应用、审核及操作反馈](../desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx#L460)
- [Review 面板的来源、操作与可恢复反馈](../desktop-app/src/renderer/src/components/local-git-review/LocalGitReviewPanel.tsx#L237)
- [本地 Git 读取、review 写操作与 turn patch 服务](../desktop-app/src/main/localGit/LocalGitService.ts#L228)
- [Git 操作的全局可访问提示](../desktop-app/src/renderer/src/components/local-git-review/LocalGitReviewProvider.tsx#L28)
- [Composer Review Mode 与本地分支控件](../desktop-app/src/renderer/src/App.tsx#L3083)
- [Review、turn patch 与分支操作的单元／组件／E2E 测试](../desktop-app/src/renderer/src/components/local-git-review/LocalGitReviewPanel.test.tsx)、[turn patch](../desktop-app/src/renderer/src/components/render-units/renderUnitDetails.test.tsx)、[E2E](../desktop-app/tests/e2e/local-git-review.e2e.ts)
- [已有 `::code-comment` 解析与安全降级](../desktop-app/src/renderer/src/lib/codeCommentDirectives.ts#L18)
- [当前 Provider 未暴露 review/start，但参考实现不以此为前置](ai-sdk-provider-codex-asp-api.md#L1029)

参考证据：

- [参考项目的 Changes 与本地 Git 操作](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L6936)
- [审核面板区分未暂存、已暂存、指定提交、分支和上一个 turn](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~onboarding-page-DWQ2hD55.js#L42301)
- [审核面板按全部、文件和 hunk 暂存、取消暂存或恢复](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~onboarding-page-DWQ2hD55.js#L30737)
- [turn 改动按 patch batches 撤销并支持重新应用](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~onboarding-page-DWQ2hD55.js#L61171)
- [Review 写操作前核对文件 revision 并报告部分结果](../reference-projects/codex-electron-26.707.72221-beautified/.vite/build/worker.js#L67577)
- [Codex Review 通过普通 turn 或新会话执行](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/review-mode-content-CRO4r5jd.js#L126)
- [Composer footer 分支搜索、创建、切换受阻与提交后重试](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/git-branch-switcher-DHRrTd6u.js#L430)

### P0-05 会话管理入口

- [x] 会话行或页头提供更多操作菜单。
- [x] 接通现有的重命名、归档和恢复归档接口。
- [x] 支持会话置顶。
- [x] 支持复制工作目录、session id、任务链接和会话 Markdown。
- [x] 归档当前会话后自动切换到合理的下一个页面。
- [x] 所有操作提供成功、失败和进行中状态。
- [x] 覆盖当前会话、后台运行会话和归档会话的测试。

状态：**已完成（2026-08-27）**

当前证据：

- [会话菜单与操作反馈](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx)
- [置顶、活动与归档列表投影](../desktop-app/src/renderer/src/sidebar/sidebarModel.ts)
- [归档查询兼容降级与持久偏好](../desktop-app/src/main/conversations/ConversationApiService.ts)
- [真实 Electron 归档、恢复与置顶回归](../desktop-app/tests/e2e/sidebar.e2e.ts)

参考证据：

- [完整会话菜单](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-overflow-menu-Co-VIJCM.js#L589)

### P0-06 审批与结构化提问补全

- [x] 命令审批展示可读命令，而不是只展示原始 JSON。
- [x] 文件修改审批展示文件列表和 diff。
- [x] 网络审批展示域名、原因和目标范围。
- [x] 支持仅本次、当前会话、相似操作和持久允许规则。
- [x] 支持单选、多选、自由文本、秘密输入和多问题表单。
- [x] 回答时保留选项值和多选数组，不降级为单一字符串。
- [x] 不把敏感参数、凭据或 provider 配置暴露给 Renderer。
- [x] 覆盖主 Agent、子 Agent、MCP、网络和秘密输入场景的测试。

状态：**已完成（2026-07-26）**

当前证据：

- [安全审批 DTO 与敏感字段白名单](../desktop-app/src/shared/codexApprovalApi.ts)
- [Main 端原始协议决策的精确重建](../desktop-app/src/main/codexChatRuntimeService.ts)
- [文件变更缓存与审批 payload 合并](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/approvals.ts)
- [可读命令、文件 diff、网络与结构化表单面板](../desktop-app/src/renderer/src/components/assistant-ui/server-request-panel.tsx)
- [审批 UI 与结构化值保真单测](../desktop-app/src/renderer/src/components/assistant-ui/server-request-panel.test.tsx)
- [安全 DTO、Main 映射与 provider 回归测试](../desktop-app/src/shared/codexApprovalApi.test.ts)、[codexChatRuntimeService.test.ts](../desktop-app/src/main/codexChatRuntimeService.test.ts)、[approvals.test.ts](../desktop-app/vendors/ai-sdk-provider-codex-asp/tests/approvals.test.ts)
- [审批重试、拒绝、并发、停止、崩溃和新 turn 的 Mock E2E](../desktop-app/tests/e2e/approvals.e2e.ts)
- [文件 diff、网络策略、秘密输入和 MCP typed form 的协议 Mock E2E](../desktop-app/tests/e2e/approval-panels.e2e.ts)

### P0-07 App Server 审批／待处理交互完整对齐

- [x] `item/permissions/requestApproval` 从 provider callback 经 Main、IPC 到 renderer 权限卡；renderer 只提交 scope intent，Main 保留原始 profile。
- [x] permission detail 支持网络、legacy read/write、entries、glob、特殊路径和 glob scan 深度；任一条无法完整解释时 fail closed。
- [x] `tool/requestUserInput` 的自动处理 deadline 由 Main 持有，首次交互 snooze 且 Other 与 option 互斥。
- [x] MCP typed form、可安全编译的 OpenAI form 和 URL 均通过同一审批 shell；Skip/Cancel/Accept 以及 URL 的打开后继续保持协议语义。
- [x] renderer 不接收 raw permission profile 或 raw OpenAI schema；秘密答案不写入 pending snapshot。

参考证据：

- [参考项目的审批与交互式问题](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~page-DRgkI91I.js#L53680)

---

## P1：任务管理和协作效率

### P1-01 Goal、Plan、Review 模式与运行参数

- [x] Composer 的 `/Goal` 与 `/Plan` 使用既有 slash command registry，分别支持独立编辑态/持久化 Goal 和 Default/Plan 模式；Goal、Plan footer 的关闭交互、动态 placeholder、线程恢复与 Goal 通知已接入。
- [x] Plan 由 Main 根据 `collaborationMode/list` preset 构造完整 `turn/start.collaborationMode`；Renderer 不能提交 developer instructions 或完整 mode object，退出 Plan 也会显式发送 Default。
- [x] Goal 通过 `thread/goal/get|set|clear` 持久化。首轮在同一 provider session 的 `turn/start` 成功后写入；已有线程按 `resume -> settings -> goal/set` 在同一 owner 上处理，不新增用户 turn；普通打开会话时读取失败不会阻断历史。
- [x] Code Review 模式：`/review` 可选择未提交改动或基础分支比较，并通过既有聊天链路执行审查。
- [x] Plan 完成、任务空闲后可明确选择进入实施；切换只变更模式，不自动发送消息。
- [x] Review 可选择未提交改动或与基准分支比较。
- [x] 模型选择器会显示 app-server 宣告的 reasoning effort；即使启用了后台模型目录，也按模型 ID 合并这项能力。用户选择经受限枚举传递给默认协作模式，Plan 仍使用服务端预设。
- [x] 支持用户配置审批策略、sandbox 范围和人格：每个会话可选择请求批准、风险操作自动批准或完全访问（后者须确认）；workspace-write 与完全访问范围由 Main 映射；模型宣告支持时可选择默认、友好或务实人格，并以受限枚举传给 `turn/start`。
- [x] `/model`、`/reasoning`、`/plan` 和 `/skills` 均具有真实行为；`/skills` 直接打开现有的技能中心。
- [x] Slash Command 注册表中的每个入口都路由到实际动作或功能面板，不保留无行为入口。
- [x] 覆盖 Goal/Plan 切换、可信请求边界、preset 解析、Goal 读写/通知和 thread resume 后的显式 mode 传递；真实 Renderer → IPC → Main → Provider → app-server E2E 已验证 Plan 参数、`/reasoning` 的默认协作模式参数，以及已有线程 Goal 的无额外用户 turn 时序。

状态：**已实现（2026-08-28）**。本轮范围和设计记录见 [Goal/Plan parity plan](../.omx/plans/goal-plan-composer-reference-parity-plan.md)。

参考证据：

- [Code Review 模式](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/review-mode-content-CRO4r5jd.js#L412)

当前证据：

- [Slash Command 注册与技能中心跳转](../desktop-app/src/renderer/src/App.tsx#L4025)
- [`/skills` 回归测试](../desktop-app/src/renderer/src/App.test.tsx#L2353)
- [审批／沙箱选择器与人格选择器](../desktop-app/src/renderer/src/components/assistant-ui/composer-approval-mode-selector.tsx)、[人格安全映射](../desktop-app/src/main/codexChatRuntimeService.ts#L883)

### P1-02 对话右侧任务工作台

- [x] 建立统一的可收起右侧面板。
- [x] 面板支持多个标签页，并保留每个会话的打开状态。
- [~] 已支持标准 `ui://` MCP App 的受限资源标签：从 Sources 打开、主进程验证关联的 MCP server 与任务记录、在无同源权限的 iframe 中渲染，并仅开放初始化、ping 和该服务的只读 `ui://` 资源读取；完整的 MCP App 工具调用、消息、模型上下文及参考实现级 Sandbox 仍未完成。Review、Browser、Files、Terminal、任务摘要、Timeline、Outputs、Sources 与进程总览已经可用。
- [x] 切换会话后恢复正确标签，不串用其他会话状态。
- [x] 小窗口下可通过标题栏“最大化工作区”进入全屏工作台，恢复后保留当前标签。
- [x] 覆盖窄窗口与最大化工作台场景；标签恢复、会话切换和任务摘要打开已有覆盖。

状态：**部分实现（2026-08-28）**

当前证据：

- [会话布局统一承载右侧与底部工作台](../desktop-app/src/renderer/src/App.tsx#L1256)
- [标签启动器提供任务、审阅、终端、浏览器和文件入口](../desktop-app/src/renderer/src/components/right-workspace/WorkspaceLauncher.tsx#L10)
- [任务摘要显示会话目标、状态和子代理](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx#L7)
- [Timeline 按会话顺序呈现消息、工具活动和子代理更新](../desktop-app/src/renderer/src/components/workspace-container/TimelineWorkspace.tsx#L7)
- [会话切换时恢复各自工作台状态的应用层测试](../desktop-app/src/renderer/src/App.test.tsx#L2460)
- [小窗口可最大化的工作台壳层](../desktop-app/src/renderer/src/components/workspace-container/WorkspacePanelShell.tsx#L195)
- [MCP App 资源授权与 IPC 边界](../desktop-app/src/main/mcp/McpAppResourceService.ts)、[受限 iframe 与 MCP Apps 最小宿主协议](../desktop-app/src/renderer/src/components/workspace-container/McpAppWorkspace.tsx)
- [窄窗口、最大化、任务与进程总览的真实 Electron 验收](../desktop-app/tests/e2e/right-workspace.e2e.ts#L22)

参考证据：

- [参考项目侧面板标签](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-side-panel-tabs-MgBvi70P.js#L23)

### P1-03 子 Agent 与后台进程管理

- [x] 在任务摘要中聚合当前会话的后台终端；子 Agent 已聚合。
- [~] 展示子 Agent 的角色、状态和模型；模型从协作启动事件按 thread id 关联，并会跨后续活动更新保留。代码增删统计缺少 app-server 协议数据。
- [x] 支持打开子 Agent 对话。
- [x] 后台终端支持打开输出、停止和重启；新建终端仍从工作台启动器进入。
- [x] 提供“查看所有进程”和批量停止入口；进程总览严格限制为当前应用窗口所属会话，并在批量停止前要求确认。
- [x] 后台任务状态在切换会话后仍保持准确。
- [x] 覆盖进程退出、停止失败和子 Agent 无 thread id 场景的测试；批量停止的 Electron E2E 覆盖真实受限 IPC。

状态：**部分实现**

当前证据：

- [已有子 Agent 内联状态与打开子会话能力](../desktop-app/src/renderer/src/components/render-units/subagentActivity.tsx#L17)
- [协作启动事件的模型按子 Agent thread id 关联到活动与任务摘要](../desktop-app/src/renderer/src/lib/assistantRenderUnits.ts)、[跨活动更新保留模型](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.ts)
- [任务摘要显示角色、模型和状态](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx)
- [任务摘要将同一子 Agent 的活动合并为当前状态](../desktop-app/src/renderer/src/components/workspace-container/taskWorkspaceSummary.ts#L10)
- [任务摘要通过受限终端 IPC 聚合、打开、停止和重启进程](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx#L100)
- [进程总览仅列出当前窗口拥有的会话，并提供确认后的批量停止](../desktop-app/src/renderer/src/components/workspace-container/ProcessesWorkspace.tsx#L20)
- [终端列表在主进程按 `ownerWebContentsId` 限制](../desktop-app/src/main/terminal/TerminalSessionManager.ts#L320)
- [任务切换后重新拉取目标会话进程的回归测试](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.test.tsx)
- [模型关联、跨活动更新与任务摘要显示的回归测试](../desktop-app/src/renderer/src/lib/assistantRenderUnits.test.ts)、[任务摘要](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.test.ts)、[工作台](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.test.tsx)

参考证据：

- [子 Agent 与后台进程摘要](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L2541)
- [后台终端操作](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L3804)

### P1-04 Outputs 产物中心

- [x] 聚合完整会话中识别到的文件、网站和外部资源；生成图片仍保留在消息内联视图。
- [x] 复用应用内文件和网站预览，以及安全的系统打开策略。
- [x] 支持从应用拖出已确认存在的本地文件；路径仅由 Main 重新校验为普通文件后才启动系统拖放。
- [x] 提供“创建文档、演示文稿、电子表格、网站”的快捷入口，并以可编辑的未发送任务开始。
- [x] 本地路径和远程资源使用不同的安全打开策略：本地路径仅经受限 Main IPC 在应用内、默认应用或文件管理器中打开；远程资源仅允许 HTTP(S) 并通过系统浏览器打开。
- [x] 产物列表可从完整会话历史恢复，不只依赖最后一条消息。
- [x] Electron 端到端覆盖初始不存在的本地文件会被过滤、已显示文件消失后会重新校验并移除，以及远程资源在内置浏览器打开；文件预览对 `not-found` 的明确错误已有组件回归；JSON-RPC app-server 夹具产生的 `imageGeneration` 事件已验证经 provider、IPC 到图片卡片的完整渲染。

状态：**已实现（2026-08-28）**

当前证据：

- [Outputs 工作台复用已有安全资源卡片](../desktop-app/src/renderer/src/components/workspace-container/OutputsWorkspace.tsx#L7)
- [Outputs 工作台将四类创建快捷入口路由到既有的新任务草稿链路](../desktop-app/src/renderer/src/components/workspace-container/OutputsWorkspace.tsx)
- [会话摘要从所有助手消息收集并去重产物](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.ts#L76)
- [完整会话中的文件、网站和 MCP 发布资源聚合回归测试](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.test.ts)
- [资源卡片根据资源类型安全地在应用内或系统中打开](../desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx#L868)
- [本地产物拖放仅由主进程校验普通文件后启动](../desktop-app/src/main/localPathDrag.ts)；[Main 与组件边界回归测试](../desktop-app/src/main/localPathDrag.test.ts)、[资源卡片测试](../desktop-app/src/renderer/src/components/render-units/renderUnitDetails.test.tsx)
- [Outputs 资源可用性和内置浏览器路由 Electron 回归](../desktop-app/tests/e2e/render-units.e2e.ts#L25)
- [app-server 图片生成协议到图片卡片的 Electron 回归](../desktop-app/tests/e2e/render-units.e2e.ts)
- [文件预览对已消失文件的错误提示回归](../desktop-app/src/renderer/src/components/right-workspace/files/FileWorkspace.test.tsx)
- [已有生成图片和结束资源卡片](../desktop-app/src/renderer/src/lib/renderUnitCapabilityMatrix.ts#L336)

参考证据：

- [参考项目 Outputs](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L2454)
- [创建文档、演示、表格和网站](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L2293)

### P1-05 Sources、引用和资源使用记录

- [x] 正确渲染 AI SDK 标准 source parts。
- [x] 助手正文中的引用可以打开对应来源（工作区文件、外部 HTTP(S) 链接和任务引用使用统一受限路由）。
- [x] 聚合用户提供、任务中读取、创建和更新的文件。
- [x] 聚合 MCP/App 工具来源和 Web 搜索词。
- [ ] 聚合访问过的网页；当前 app-server 转录事件未提供经过验证的访问 URL，不能从工具文本推测或伪造浏览历史。
- [x] 提供完整 Sources 清单和来源使用次数（当前覆盖 AI SDK 标准 URL/文档来源）。
- [x] 来源缺失或 URL 不安全时使用安全降级展示。
- [x] 覆盖 source-url、source-document、用户附件、文件活动、Web 搜索和 MCP/App 来源的回归测试。

状态：**部分实现**

当前证据：

- [main 已请求发送 Sources](../desktop-app/src/main/codexChatRuntimeService.ts#L926)
- [标准来源归一化为可安全渲染的来源卡片](../desktop-app/src/renderer/src/lib/assistantRenderUnits.ts#L1055)
- [来源卡片仅通过受限 HTTP(S) 外部打开桥接](../desktop-app/src/renderer/src/components/render-units/renderUnitDetails.tsx#L272)
- [Sources 工作台聚合完整会话并显示使用次数](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.ts#L80)
- [会话摘要仅从可结构化的用户附件、读写文件、Web 查询词和 MCP/App 元数据聚合活动来源](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.ts)
- [Sources 工作台将可导航的引用与不可导航的任务活动分开渲染](../desktop-app/src/renderer/src/components/workspace-container/SourcesWorkspace.tsx)
- [Sources 会话聚合回归测试](../desktop-app/src/renderer/src/lib/taskWorkspaceSummary.test.ts)、[活动来源工作台测试](../desktop-app/src/renderer/src/components/workspace-container/SourcesWorkspace.test.tsx)
- [助手正文引用的分类、受限解析与打开动作](../desktop-app/src/renderer/src/components/render-units/inlineReference.tsx)、[动作解析](../desktop-app/src/renderer/src/lib/referenceInlineAction.ts)
- [正文引用的渲染与交互测试](../desktop-app/src/renderer/src/components/render-units/inlineReference.test.tsx)、[Streamdown 集成测试](../desktop-app/src/renderer/src/components/render-units/inlineReference.streamdown.test.tsx)

参考证据：

- [参考项目 Sources 汇总](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L10150)
- [资源活动类型](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L11205)

### P1-06 环境、分支与可复用运行操作

- [x] 对话页可以查看当前环境，并可连接带有 Codex 执行服务地址的远程项目；新建和续接任务都会选择该远程环境。
- [ ] 支持选择分支、worktree、本地/云端执行目标和远程主机（远程主机已支持，分支、worktree 和云端目标仍待补齐）。
- [x] 支持为项目配置可复用 Actions。
- [x] Actions 可以一键运行测试、启动开发服务器或执行项目命令。
- [x] Action 的运行状态与后台终端面板联动。
- [x] 非 Git 项目明确说明不能选择分支或 worktree。
- [ ] 覆盖环境切换、Action 失败和远程主机场景的测试。

状态：**部分实现**

当前证据：

- [项目 Action 定义按项目或已注册路径持久化，并在主进程校验作用域](../desktop-app/src/main/projects/ProjectApiService.ts#L406)
- [任务摘要提供添加、编辑、删除和一键运行的操作区](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx#L198)
- [任务摘要显示本地、远程、受管 worktree 或项目外的当前执行环境，并保留能力边界](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx)
- [远程项目连接表单保存受限的 ws/wss 执行服务地址](../desktop-app/src/renderer/src/projects/CreateRemoteProjectDialog.tsx)
- [主进程将已验证的远程项目解析为 app-server 环境选择](../desktop-app/src/main/projects/ProjectService.ts#L207)
- [Provider 先注册环境，再在新建或续接任务中选择它](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/model.ts#L1317)
- [运行 Action 后自动打开对应后台终端输出](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.tsx#L300)
- [Action 配置、作用域选择和运行终端的回归测试](../desktop-app/src/main/projects/ProjectApiService.test.ts#L6)
- [远程环境注册与新建/续接任务选择的协议测试](../desktop-app/vendors/ai-sdk-provider-codex-asp/tests/model.stream.test.ts#L2143)
- [任务环境与项目外降级测试](../desktop-app/src/renderer/src/components/workspace-container/TaskWorkspace.test.tsx)

参考证据：

- [环境 Actions 和环境切换](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L6129)

### P1-07 GitHub PR 协作闭环

- [~] 本地仓库支持检查 GitHub 远端、显示当前分支并由用户明确触发推送；远程项目暂不能使用本机 `gh`。
- [x] 支持创建 Draft/Ready PR，并展示 PR 状态、CI 检查、评论、reviewer 和合并状态。
- [x] 可针对失败检查、评论和冲突创建带安全说明的修复任务草稿；草稿不会自动发送、改代码或推送。
- [x] 支持请求 review、提交批准／请求修改／评论审查、发布评论，以及打开 GitHub 页面。
- [x] 固定 PR 界面通过 Main 层的稳定能力接口访问 GitHub；Renderer 不接触 CLI、令牌、任意命令或原始 CLI 输出。
- [~] GitHub CLI 已作为可选的本地增强；当前没有可用 GitHub 插件或 App/Connector，因此尚不能作为首选路径。
- [~] 无远端、非 GitHub 远端、GitHub CLI 未安装、未登录或权限不足、网络不可达时提供明确降级，并保留本地 Git 和 Review 能力；插件不可用的独立降级仍待其接入后验证。
- [~] 已覆盖无远端、未授权、GitHub CLI 不可用、远程工作目录、CI 失败、评论修复和合并冲突；插件不可用仍待可用插件接入后验证。

状态：**部分实现（2026-08-28）**

当前证据：

- [固定 GitHub CLI 服务与会话仓库重校验](../desktop-app/src/main/githubPullRequests/GithubPullRequestService.ts)
- [GitHub CLI 非交互执行与输出大小限制](../desktop-app/src/main/githubPullRequests/githubCli.ts)
- [受限 IPC 协议](../desktop-app/src/shared/githubPullRequestApi.ts) 与 [preload 白名单](../desktop-app/src/preload/index.ts)
- [PR 工作台](../desktop-app/src/renderer/src/components/workspace-container/PullRequestWorkspace.tsx)
- [PR 修复草稿不会触发 GitHub 写操作的组件回归测试](../desktop-app/src/renderer/src/components/workspace-container/PullRequestWorkspace.test.tsx)

参考证据：

- [参考项目把本地 Git 与 gh-pr IPC 注册为不同能力](../reference-projects/codex-electron-26.707.72221-beautified/.vite/build/main-CpD8a18d.js#L32215)
- [参考项目的 GitHub CLI 安装与登录检查](../reference-projects/codex-electron-26.707.72221-beautified/.vite/build/src-HagpvBpE.js#L54206)
- [参考项目通过 gh pr create 创建 PR](../reference-projects/codex-electron-26.707.72221-beautified/.vite/build/src-HagpvBpE.js#L54358)
- [参考项目也支持 GitHub Connector/Plugin 路径](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/app-initial~app-main~quick-chat-window-page~chatgpt-conversation-page-CrA1-JEm.js#L231348)
- [reviewer、CI 与 PR 自动修复](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-page-DRtMyF4d.js#L2320)

### P1-08 任务搜索、会话内查找与快捷键

- [x] 支持跨项目搜索任务，且包含归档任务。
- [x] 支持在当前会话内查找文本，并可在用户与助手消息之间跳转。
- [x] 支持按当前侧栏排序跳转到上一任务和下一任务（归档任务不参与）。
- [x] 提供统一命令面板，可启动任务、聚焦任务搜索、打开插件中心和切换侧栏。
- [x] 提供原生 File、View、Help 菜单。
- [x] 快捷键可搜索、修改、恢复默认并检测冲突。
- [x] 不与输入法、编辑器和系统快捷键发生明显冲突。
- [x] 覆盖 macOS、Windows 和 Linux 的核心快捷键测试。

状态：**已实现（2026-08-28）**

当前证据：

- [对话查找条提供快捷键、计数、跳转和关闭清理](../desktop-app/src/renderer/src/components/conversation/ConversationFindBar.tsx#L13)
- [真实聊天页面的对话查找 Electron 验收](../desktop-app/tests/e2e/conversation-find.e2e.ts#L8)
- [侧栏全局任务搜索会检索所有项目及归档任务](../desktop-app/src/renderer/src/sidebar/taskSearch.ts#L3)
- [侧栏任务搜索与归档恢复 Electron 验收](../desktop-app/tests/e2e/sidebar.e2e.ts#L133)
- [任务头部按侧栏顺序计算相邻任务](../desktop-app/src/renderer/src/sidebar/taskNavigation.ts#L9)
- [相邻任务切换 Electron 验收](../desktop-app/tests/e2e/task-navigation.e2e.ts#L8)
- [全局命令面板复用既有应用操作，并通过 ⌘/Ctrl+K 打开](../desktop-app/src/renderer/src/components/command-palette/AppCommandPalette.tsx)
- [主进程安装 File、View、Window 和 Help 菜单；菜单操作只经预加载事件回到渲染层](../desktop-app/src/main/applicationMenu.ts)
- [快捷键配置、冲突与系统保留组合校验](../desktop-app/src/shared/keyboardShortcutsApi.ts)
- [本地持久化与主进程 IPC 校验](../desktop-app/src/main/keyboardShortcuts/KeyboardShortcutService.ts)
- [可搜索、可录制与可恢复默认的快捷键面板](../desktop-app/src/renderer/src/components/keyboard-shortcuts/KeyboardShortcutDialog.tsx)

参考证据：

- [参考项目快捷键搜索与编辑](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/keyboard-shortcuts-settings-CLU9-DGr.js#L118)

### P1-09 归档任务中心

- [x] 提供侧栏中的归档任务抽屉。
- [x] 支持归档任务搜索、项目与类型筛选、按项目分组和独立排序；类型筛选只将 app-server 明确标记为 `automation` 的任务归为自动化。
- [x] 支持恢复单个归档任务。
- [x] 支持永久删除单个已归档任务和按项目批量删除（任务记录、排队消息、本地任务元数据和差异缓存会清理；用户工作文件保留）。
- [x] 自动化任务与普通任务可以区分；仅 app-server 明确返回 `threadSource: "automation"` 的任务显示“自动化”标签。
- [x] 删除操作必须有二次确认和清晰的不可恢复提示。
- [x] 已覆盖归档搜索、项目/类型筛选、分组、排序、恢复、单个删除、项目批量删除、删除失败和大量归档任务；每个项目组默认渐进显示 50 项，避免一次渲染整组结果。

状态：**已实现（2026-08-28）**

当前证据：

- [已归档任务的永久删除确认与不可恢复提示](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx)
- [主进程仅允许删除已归档、非运行中的任务，并清理任务元数据](../desktop-app/src/main/conversations/ConversationApiService.ts)
- [排队消息快照和本地 turn diff 的清理](../desktop-app/src/main/followUps/ConversationFollowUpQueueService.ts)、[差异缓存](../desktop-app/src/main/conversations/TurnDiffStore.ts)
- [删除确认、会话服务、排队快照和差异缓存的回归测试](../desktop-app/src/renderer/src/sidebar/ConversationRow.test.tsx)、[会话服务](../desktop-app/src/main/conversations/ConversationApiService.test.ts)、[队列](../desktop-app/src/main/followUps/ConversationFollowUpQueueService.test.ts)、[差异缓存](../desktop-app/src/main/conversations/TurnDiffStore.test.ts)
- [项目归档批量删除的二次确认](../desktop-app/src/renderer/src/sidebar/SidebarChatsSection.tsx)、[整组预校验与主进程删除](../desktop-app/src/main/conversations/ConversationApiService.ts)、[组件与服务回归测试](../desktop-app/src/renderer/src/sidebar/SidebarRoot.test.tsx)、[会话服务](../desktop-app/src/main/conversations/ConversationApiService.test.ts)

当前证据：

- [归档抽屉提供搜索、项目与类型筛选、分组、排序与空结果降级](../desktop-app/src/renderer/src/sidebar/SidebarChatsSection.tsx#L105)
- [归档分组、项目/类型筛选、项目标签搜索与独立排序单元验证](../desktop-app/src/renderer/src/sidebar/archiveTasks.test.ts)
- [归档会话与活跃会话分开投影](../desktop-app/src/renderer/src/sidebar/sidebarModel.ts#L16)
- [app-server `threadSource` 经 Main 透传到侧栏，自动化来源显示受限标签](../desktop-app/src/main/conversations/AppServerThreadClient.ts)、[侧栏任务行](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx)
- [自动化来源透传与侧栏标签回归测试](../desktop-app/src/main/conversations/AppServerThreadClient.test.ts)、[会话服务](../desktop-app/src/main/conversations/ConversationApiService.test.ts)、[侧栏](../desktop-app/src/renderer/src/sidebar/ConversationRow.test.tsx)
- [恢复操作通过既有受限 conversations API](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx#L280)
- [归档、搜索和恢复的 Electron 验收](../desktop-app/tests/e2e/sidebar.e2e.ts#L112)

参考证据：

- [参考项目归档任务搜索、筛选和排序](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/data-controls-DlUaxiOy.js#L2519)

---

## P2：平台型增强

### P2-01 从对话创建和管理定时任务

- [x] 可从当前对话创建定时任务。
- [x] 可查看任务计划、下次运行时间和最近运行状态。
- [x] 可暂停、恢复、编辑和删除定时任务。
- [x] 自动化运行与原始对话建立可追踪关系。
- [ ] 当前 `automationUpdate` 状态卡可以跳转到对应任务。

状态：**部分实现**

当前证据：

- [对话菜单中的创建和管理入口，以及计划、下次执行与运行记录界面](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx)、[定时任务对话框](../desktop-app/src/renderer/src/sidebar/AutomationDialog.tsx)
- [本机持久化、原子写入、暂停/恢复/编辑/删除、下次执行计算和运行记录](../desktop-app/src/main/automations/AutomationStore.ts)、[本地调度服务](../desktop-app/src/main/automations/AutomationService.ts)
- [shared schema、preload 白名单和 Main IPC 校验](../desktop-app/src/shared/automationApi.ts)、[preload](../desktop-app/src/preload/index.ts)、[Main](../desktop-app/src/main/index.ts)
- [自动化新任务只经既有 app-server 聊天链路创建，并带 `threadSource: automation` 供侧栏识别](../desktop-app/src/main/codexChatRuntimeService.ts)、[provider thread/start 映射](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/model.ts)
- [新自动化任务立即投影到会话列表，并继承源任务窗口以接收后续审批](../desktop-app/src/main/index.ts)、[窗口路由](../desktop-app/src/main/conversations/ConversationWindowRouter.ts)
- [调度、源项目环境快照、终态记录、删除任务时清理计划关联与重启恢复回归测试](../desktop-app/src/main/automations/AutomationService.test.ts)、[磁盘持久化校验](../desktop-app/src/main/automations/AutomationStore.test.ts)、[对话入口组件测试](../desktop-app/src/renderer/src/sidebar/ConversationRow.test.tsx)

已实现边界：

- 调度只在应用运行期间于本机执行；应用退出期间不会补跑错过的一次性任务，也不宣称存在云端计划服务。
- 创建时会快照原始对话的项目选择；每次运行会创建独立 app-server 任务，并在本地记录新任务 id。
- 当前 app-server 仅可标记自动化任务来源，尚未提供可供状态卡定位本地计划项的 `automationUpdate` 标识。因此不能把状态卡伪装成可跳转入口。

参考证据：

- [参考项目从对话创建定时任务](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-overflow-menu-Co-VIJCM.js#L703)

### P2-02 多窗口与深链接

- [x] 支持在新窗口打开任务。
- [x] 支持复制可回到当前任务的应用链接。
- [x] 应用启动时可以通过深链接定位本地或远程任务。
- [x] 多窗口之间正确隔离审批、活动任务和导航状态。
- [x] 外部 HTTP 链接仍然通过安全策略交给系统浏览器。

状态：**已实现（2026-08-28）**

当前证据：

- [任务菜单可将既有任务交给新 Electron 窗口；新窗口启动后按任务链接恢复](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx)
- [主进程把任务、线程和审批固定路由到所属窗口，并在窗口关闭时回收归属](../desktop-app/src/main/conversations/ConversationWindowRouter.ts)
- [审批列表、响应和延后操作均按发起窗口过滤和校验](../desktop-app/src/main/index.ts)
- [真实 Electron 回归覆盖在运行中从侧栏打开新窗口后，任务流和历史在新旧窗口均可续接](../desktop-app/tests/e2e/task-windows.e2e.ts)
- [任务菜单生成并复制受限格式的应用链接](../desktop-app/src/renderer/src/sidebar/ConversationRow.tsx#L204)
- [链接解析只接受单一任务 id，拒绝携带查询、片段或控制字符的 URL](../desktop-app/src/shared/conversationLink.ts)
- [主进程处理第二实例和系统 deep link，并在渲染器就绪后投递](../desktop-app/src/main/index.ts#L159)
- [应用启动消费待处理 deep link 的回归测试](../desktop-app/src/renderer/src/App.test.tsx)
- [当前窗口策略拒绝全部内部 window.open](../desktop-app/src/main/index.ts#L342)

参考证据：

- [参考项目的新窗口和任务链接菜单](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-overflow-menu-Co-VIJCM.js#L624)

### P2-03 长会话用户消息导航轨

- [x] 用户消息达到一定数量后显示轻量导航轨。
- [x] 点击标记可跳转到对应用户消息。
- [x] 滚动时自动高亮当前消息。
- [x] 未加载到 DOM 的历史消息可以先补加载再跳转。
- [x] 导航轨不遮挡正文、审批和输入框。

状态：**已实现（2026-08-28）**

当前证据：

- [历史任务默认仅挂载末尾 120 条；用户标记和查找请求可以补挂载完整历史](../desktop-app/src/renderer/src/App.tsx)
- [用户消息导航轨按完整用户消息列表建立标记；目标不在 DOM 时请求补挂载并在出现后滚动](../desktop-app/src/renderer/src/components/conversation/UserMessageNavigationRail.tsx#L14)
- [窄窗口隐藏导航轨；宽窗口将其定位在正文最大宽度之外](../desktop-app/src/renderer/src/components/conversation/UserMessageNavigationRail.tsx)
- [导航轨补挂载后定位的组件回归](../desktop-app/src/renderer/src/components/conversation/UserMessageNavigationRail.test.tsx)
- [121 条历史刷新、补挂载和定位的 Electron 验收](../desktop-app/tests/e2e/user-message-navigation.e2e.ts#L54)

参考证据：

- [参考项目用户消息导航轨](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/thread-user-message-navigation-rail-Ak-cnJuJ.js#L428)

### P2-04 语音输入与全局听写

- [~] Composer 支持基于系统 Web Speech 的实时听写、结束和再次开始；识别服务的具体失败原因目前不能由标准接口可靠读取。
- [x] 转写结果自动插入输入框，用户可以继续编辑或正常发送。
- [ ] 可选提供全局听写悬浮窗和快捷键。
- [~] 听写开始时明确显示麦克风权限请求，运行中显示实时转写和结束控件；Web Speech 不产生可由本应用展示的音频上传进度。
- [~] 已覆盖支持与不支持 Web Speech 的界面和运行时配置；拒绝权限、无输入设备与识别服务错误需要平台可控的 SpeechRecognition 测试替身。

状态：**部分实现（2026-08-28）**

当前证据：

- [会话运行时仅在浏览器支持时注册连续、实时的 Web Speech 听写适配器](../desktop-app/src/renderer/src/App.tsx)
- [Composer 提供开始、结束、权限请求与实时转写状态](../desktop-app/src/renderer/src/App.tsx)
- [支持与不支持 Web Speech 的运行时配置和控件回归](../desktop-app/src/renderer/src/App.test.tsx)

参考证据：

- `reference-projects/codex-electron-26.707.72221-beautified/webview/assets/global-dictation-page-CBbV32ig.js`

### P2-05 Browser / Computer Use 画中画

- [x] 对话工作台可打开 Browser 标签。
- [ ] Computer Use 运行时可显示或隐藏画中画。
- [ ] 画中画状态与当前任务严格绑定。
- [x] 浏览器外链访问通过独立安全策略处理；浏览器授权和历史记录尚未形成 Computer Use 专属策略。

状态：**部分实现（2026-08-28）**

当前证据：

- [工作台注册 Browser 标签的创建、激活、隐藏与销毁](../desktop-app/src/renderer/src/components/workspace-container/WorkspaceContentRegistry.tsx)
- [Browser 标签提供地址栏和前进、后退、刷新、停止操作](../desktop-app/src/renderer/src/components/right-workspace/browser/BrowserWorkspace.tsx)
- [页面内文档与锚点跳转会安全同步到 Browser 地址栏，并在新页面到达时清除旧站点图标](../desktop-app/src/main/rightWorkspace/BrowserWorkspaceService.ts)
- [主进程浏览器服务拒绝不安全导航、将新窗口请求外部打开并拒绝网页权限](../desktop-app/src/main/rightWorkspace/BrowserWorkspaceService.ts)
- [浏览器服务安全边界和导航同步回归测试](../desktop-app/src/main/rightWorkspace/BrowserWorkspaceService.test.ts)

参考证据：

- [参考项目 Computer Use 画中画](../reference-projects/codex-electron-26.707.72221-beautified/webview/assets/local-conversation-thread-TggZ39FG.js#L9700)

### P2-06 消息级补充操作

- [x] 用户消息支持复制。
- [x] 助手消息支持重新生成。
- [x] 助手消息支持好评和差评（仅提交任务标识、来源 turn、正/负评价和固定来源标签；不附带日志、附件或回复正文）。
- [x] 失败消息提供明确的重试按钮；重试复用前一条用户消息，创建新的终端 turn，不会把失败输出伪装为完成。
- [x] 消息操作在任务运行中和历史会话中行为一致。

状态：**已实现（2026-08-28）**

当前证据：

- [用户消息复用 assistant-ui 的复制与已复制状态](../desktop-app/src/renderer/src/App.tsx#L3375)
- [助手消息复用既有 reload 运行时实现重新生成](../desktop-app/src/renderer/src/App.tsx#L3440)
- [助手消息好评/差评控件与单次提交状态](../desktop-app/src/renderer/src/App.tsx#L3609)
- [反馈 IPC 白名单与参数校验](../desktop-app/src/shared/codexIpcApi.ts#L684)
- [provider 显式禁用日志上传](../desktop-app/vendors/ai-sdk-provider-codex-asp/src/history-client.ts#L259)
- [失败助手消息提供可访问的重试按钮](../desktop-app/src/renderer/src/App.tsx#L2544)
- [用户和助手操作栏在任务运行时统一隐藏；失败重试在运行中禁用](../desktop-app/src/renderer/src/App.tsx#L3681)
- [运行中重试禁用和重复重新生成合并回归](../desktop-app/src/renderer/src/App.test.tsx#L3023)
- [历史助手消息的分叉和反馈操作回归](../desktop-app/src/renderer/src/App.test.tsx#L5973)
- [失败 turn 重试使用新的终端请求](../desktop-app/src/renderer/src/runtime/ConversationTranscriptController.test.ts#L1182)
- [真实 Electron 重试验收](../desktop-app/tests/e2e/follow-up-failures.e2e.ts#L393)
- [共享协议已经允许 regenerate-message](../desktop-app/src/shared/codexIpcApi.ts#L92)

---

## 推荐交付批次

### 批次一：对话不中断

- [x] P0-01 运行中追问队列与 Steer
- [x] P0-02 活跃任务重连与局部恢复
- [x] P0-05 会话管理入口
- [x] P0-06 审批与结构化提问补全

### 批次二：任务可管理

- [x] P0-03 从任意消息继续与任务分叉
- [x] P1-02 对话右侧任务工作台
- [ ] P1-03 子 Agent 与后台进程管理
- [x] P1-04 Outputs 产物中心
- [x] P1-05 Sources、引用和资源使用记录

### 批次三：开发协作闭环

- [x] P0-04 本地 Git 改动审核与恢复
- [x] P1-01 Goal、Plan、Review 模式与运行参数
- [ ] P1-06 环境、分支与可复用运行操作（部分实现）
- [ ] P1-07 GitHub PR 协作闭环
- [x] P1-08 任务搜索、会话内查找与快捷键
- [x] P1-09 归档任务中心

### 批次四：平台增强

- [ ] 完成所有 P2 条目。

## 完成定义

每个能力只有同时满足以下条件，才可以勾选完成：

- 用户可以从对话界面发现并完成完整操作。
- Renderer、preload、main 和 provider 的职责边界清晰。
- 不修改或绕过 Codex app server。
- 错误、取消、重试和恢复路径可见。
- 不向 Renderer 暴露 API key、provider headers 或完整模型配置。
- 有针对新增行为的单元测试。
- 涉及真实聊天链路时，有 renderer → IPC → main → provider → app-server 的端到端验证。
- `npm --prefix desktop-app run lint` 通过。
- `npm --prefix desktop-app test` 通过。
- 涉及 provider 时，其 lint、typecheck 和相关测试通过。

## 证据可靠性说明

- 参考目录来自发布包解包与排版结果，没有 source map，无法可靠恢复原始组件名和类型。
- 本清单中的“参考项目具备”均来自可见菜单、状态文案和操作处理逻辑。
- Voice、Computer Use、Cloud、PR 等能力可能受平台、账号或实验开关限制，因此放在相应的较低优先级或要求提供降级行为。
- 参考目录边界说明见：
  [reference-projects/codex-electron-26.707.72221-beautified/\_analysis/README.md](../reference-projects/codex-electron-26.707.72221-beautified/_analysis/README.md)
