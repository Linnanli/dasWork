# Agent Governance Toolkit 接入评估与分期建议

日期：2026-09-28。状态：方案评估，尚未实施或验证真实 app-server hook。

## 目标与假设

回答本项目接入 Microsoft Agent Governance Toolkit（AGT）需要哪些工作、优先哪些功能以及工作量。估算以一名熟悉仓库的开发者、桌面本地部署、复用现有审批界面为前提；人日为工程判断，包含测试与基本发布验证，不是工期承诺。

建议从 Electron Main 内的 TypeScript SDK 开始。治理层负责决定业务操作是否允许，现有 Codex app-server 继续负责推理、工具执行与 sandbox。初期不增加 Python 常驻服务或分布式 Agent Mesh。[E1][E2][X1][X2]

## 当前证据

| 编号 | 已确认事实 | 来源 |
| --- | --- | --- |
| E1 | 原生 dynamicTools 与 Native Pipe 兼容入口复用 Main 的注册表；工具目录在新任务创建时发布 | [DesktopHostCapabilityRuntime.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts:66)、[nativePipeServer.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/appTools/nativePipeServer.ts:275)、[ADR](/Users/nallylin/Documents/code/dasCowork/docs/adr/2026-09-06-codex-app-tools-primary-runtime-parity.md:12) |
| E2 | 当前 Main 注册工具只有 read_thread_terminal 和 load_workspace_dependencies；后者返回依赖路径，OfficeCLI/Node/Python 的后续执行不是同一次注册表调用 | [注册处](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/appTools/DesktopHostCapabilityRuntime.ts:66)、[执行入口](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/appTools/DynamicAppToolRegistry.ts:120)、[Runtime 说明](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/primaryRuntime/workspaceDependencyInstructions.ts:11) |
| E3 | 原生 command/file-change/permission 等审批与宿主工具调用分别路由；现有审批协议没有通用的全量工具执行前请求 | [NativeCodexRunDriver.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/NativeCodexRunDriver.ts:427)、[ServerRequest.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/ServerRequest.ts:20) |
| E4 | 默认 on-request + workspace-write，完全访问 never + danger-full-access；审批 Broker 只能处理实际收到的请求 | [approvalSettingsForMode](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexChatRuntimeService.ts:2466) |
| E5 | 已有挂起、超时和校验的审批交互，但类型只覆盖原生请求；宿主业务治理审批需要独立业务类型 | [codexApprovalBroker.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexApprovalBroker.ts:59)、[codexApprovalApi.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/shared/codexApprovalApi.ts:3) |
| E6 | 仓库内 Codex core 在 handler 执行前调用 PreToolUse，deny 可提前返回；MCP 参数也有 hook 入口 | [registry.rs](/Users/nallylin/Documents/code/dasCowork/codex/codex-rs/core/src/tools/registry.rs:495)、[mcp.rs](/Users/nallylin/Documents/code/dasCowork/codex/codex-rs/core/src/tools/handlers/mcp.rs:180) |
| E7 | hook 执行/解析错误可能继续执行，ask 不支持，write_stdin 跳过 PreToolUse；仓库源码不能证明生产 PATH binary 的 hook 能力 | [错误处理](/Users/nallylin/Documents/code/dasCowork/codex/codex-rs/hooks/src/events/pre_tool_use.rs:195)、[ask](/Users/nallylin/Documents/code/dasCowork/codex/codex-rs/hooks/src/events/pre_tool_use.rs:532)、[write_stdin](/Users/nallylin/Documents/code/dasCowork/codex/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs:110) |
| E8 | 用量通知包含累计 total 和 last，normalizer 当前只保存 last 并在 finish 附上；已有 turn/interrupt 可以复用 | [ThreadTokenUsage.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/protocol/app-server-protocol/v2/ThreadTokenUsage.ts:6)、[normalizer](/Users/nallylin/Documents/code/dasCowork/desktop-app/vendors/codex-app-server-client/src/run-events/CodexRunEventNormalizer.ts:1229)、[interrupt](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexRun/NativeCodexRunDriver.ts:546) |
| E9 | 现有 journal 用于流式重连，存在容量上限与清空行为，不能直接充当持久治理审计 | [codexChatRuntimeService.ts](/Users/nallylin/Documents/code/dasCowork/desktop-app/src/main/codexChatRuntimeService.ts:1163) |

外部依据：

- X1：[官方 TypeScript 能力矩阵](https://microsoft.github.io/agent-governance-toolkit/PACKAGE-FEATURE-MATRIX/)；[SDK package](https://github.com/microsoft/agent-governance-toolkit/blob/main/agent-governance-typescript/package.json)。SDK 支持 policy、audit、identity、MCP scanner、kill switch 等，仍标记 Public Preview。采用前应核对实际发布包并固定版本。
- X2：[Codex CLI adapter 说明](https://github.com/microsoft/agent-governance-toolkit/blob/main/agent-governance-codex-cli/README.md)。它是单独的 CLI hook adapter，尚未发布 npm；review 映射为 deny，存在 hook 信任、超时继续执行、无可靠输出脱敏、并发 audit 写入竞争等限制。
- X3：[AGT 已知边界](https://microsoft.github.io/agent-governance-toolkit/LIMITATIONS/)。治理决策不能证明外部操作成功，也不能充当 OS 隔离或保证模型内容正确；kill handler 完成不能独立证明外部进程停止。
- X4：[动作绑定审批 ADR](https://microsoft.github.io/agent-governance-toolkit/adr/0030-action-bound-approval-protocol/)。审批应绑定具体操作、参数、策略版本与有效期，由宿主在执行前检查。

## 功能优先级

1. **规则与权限治理**：项目允许的工具、授权范围、网络设置和执行模式；Main 调用 SDK 后执行允许/拒绝/待审批结果。强制规则拒绝优先于用户批准，不能因切换完全访问或通过另一兼容入口绕过。[E1][E3][E4][X1]
2. **审批衔接**：复用现有 UI、上下文、超时处理；宿主工具增加治理业务审批类型，绑定参数摘要与策略版本。原生审批仍按 app-server 真实请求回应。[E3][E5][X4]
3. **持久审计**：记录可信项目/任务/轮次/调用关联、策略版本、规则、决策、审批、执行结果；脱敏、串行持久写入、保留与导出。区分“允许”“开始执行”和“结果”，验证链只能检测其支持的篡改范围，不能宣称抵抗拥有本机文件权限的攻击者。[E9][X1][X3]
4. **限额与停止**：先支持宿主工具频次和任务次数限制、停止新调用、复用 interrupt；再扩展累计 token 通知与估算费用。实际用量通知后的中止可能超出额度，不宣称零超额或已经撤销外部副作用。[E8][X3]
5. **MCP/插件检查**：扫描可获取的工具名称、描述和 schema，记录版本变化与风险提示；作为辅助检测。第三方 MCP 目录与调用覆盖须独立验证，不把 codex_app 兼容入口当成全部 MCP 的代理。[E1][E3][X1][X2]

初期使用 Main 已知身份做归属关联。跨组织身份、mTLS、信任评分驱动授权、Agent Mesh、Saga 与完整合规管理放入后续企业需求；现有 sandbox 不由 AGT execution rings 替换。[X1][X3]

## 接入步骤

1. **验证真实边界（2–4 人日原型）**：固定 SDK 版本，建立最小 Main adapter，证明两个宿主工具的 allow/deny/audit；用项目实际 PATH app-server 验证 shell、apply_patch、第三方 MCP 的 hook 执行、版本、信任和失效处理。输出覆盖表与明确缺口。[E1][E2][E6][E7][X2]
2. **建立 Main 治理服务**：新增 Main-owned policy/context/audit 服务，绑定项目、用户和任务；可信策略存储与模型可写工作区分开，项目建议不能削弱强制规则。通过 Registry 统一管宿主工具，通过 runtime 管任务启动和执行模式，通过 Broker 管实际原生审批。AI-free client 只按需增加中性事件能力，不引入业务策略。[E1][E3][E4][E8]
3. **接产品界面和持久记录**：shared 增加治理状态、审批类型、审计查询与配置校验，preload 提供白名单 API，renderer 展示命中规则/待审批/额度/导出。批准后执行前重验动作绑定，重连不重做动作，过期与重启不自动放行。[E5][E9][X4]
4. **补充限额与扫描**：扩展累计用量事件，映射 interrupt 与工具 AbortSignal；绑定 MCP catalog 扫描和 schema 摘要。新任务工具目录按既有快照规则发布，运行中吊销在每次受控操作执行前生效。[E1][E8][X1][X3]
5. **决定 native hook 上线范围**：仅对真实验证覆盖的操作声明执行前检查；现有失败继续执行和 write_stdin 缺口需保留在能力说明。如果目标要求所有路径发生治理故障都拒绝执行，而受支持协议不满足，应讨论协议边界与目标，不能在 Main 假造能力或修改禁止修改的 app-server。[E6][E7][X2]

## 验收标准与验证

- 宿主工具 deny 后 handler 调用次数为零，native 与 Pipe 两种入口决策一致。
- 待审批期间无执行；拒绝、超时、参数变化、策略变化、重复和过期审批均不会产生错误放行。
- 任务恢复保持既有 dynamicTools 目录；重复流式重放不重复审计决策或工具副作用。
- 强制禁止的执行模式不能从 renderer 请求启用；必要的治理模块失败后受控能力关闭，正常聊天的实际可用范围有明确说明。
- 用量更新按累计值和恢复基线去重，阈值命中停止新工作并发送 interrupt，界面明确统计/费用估算精度和可能超额。
- 审计重启可恢复，并发无丢失；篡改校验失败可见；导出不泄露密钥和完整敏感参数。
- 真实 app-server 测试分别检查 shell、apply_patch、第三方 MCP、write_stdin、hook 未信任、超时、崩溃和非法响应；通过前不声明完整 native 管控。
- 实施后执行针对性单元/集成测试、Desktop lint/typecheck/test；修改 client 时执行其 qa；执行 native runtime/protocol verifier、真实 app-server contract 与覆盖 Renderer → Main → app-server 的 e2e。若改 bundled plugin，再执行对应验证与打包烟测。

本次为资料与源码评估，未运行上述实施后的验收测试。

## 工作量判断

以下为累计量级估算，不相加；范围决定工期。

| 范围 | 估算 | 交付边界 |
| --- | --- | --- |
| 原型 | 2–4 人日 | 宿主工具规则、最小审计、真实 hook 能力探测 |
| 可用第一版 | 10–20 人日，约 2–4 工作周 | 已确认 Main 管控范围、审批、持久审计、基本限额、最小设置页和验证 |
| 扩展企业治理 | 30–60+ 人日 | 中央策略分发、组织权限、MCP 深度治理、集中审计和跨平台发布；按确认后的覆盖范围重新估算 |

“所有内建工具和第三方工具、所有失败情况均强制阻断”目前无法给确定工期：SDK 存在并不代表宿主协议具备该保证。最大不确定性是生产 Codex binary 版本与 hooks 失效/覆盖语义，而不是 npm 安装。[E7][X2]
