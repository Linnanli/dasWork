# Primary Runtime 合成交付链历史测试说明（已被取代）

状态：**已被取代，不再执行。** 生产实现、发布条件和剩余工作只以 [`primary-runtime-reference-architecture-and-live-presentations-plan.md`](./primary-runtime-reference-architecture-and-live-presentations-plan.md) 为准。本文件只保留 synthetic lane 的历史边界，不能作为第二份计划、恢复条件或发布真相源。

## 1. 被取代原因

旧版本把 synthetic feed 验证与生产来源决策混在一起，并仍把取得私有 `@oai/artifact-tool`/OpenAI Presentations 制品写成恢复生产计划的前提。这与当前决策冲突：生产使用经过授权和来源审计的 `siril9/presentation-skill`，除 plugin 内容与依赖外，其余 Primary Runtime 架构按参考项目复刻。

旧版本还要求生产 v1/v2 manifest 强制绑定私有包身份。该要求已经失效；通用 format v2、只读 legacy-v2 兼容、loader 白名单路径、普通 app-server command 执行链和正式 release gate 全部由主计划定义。

## 2. 可以保留的测试资产

现有 synthetic builder、archive、feed runner 和 E2E 可以继续作为非发布回归测试，但必须同时满足：

1. 全链标记 `synthetic-test-only`，使用仓库自有包名、插件内容、签名材料和 provenance；不得复制参考项目、用户缓存或私有 OpenAI 产物。
2. 只验证协议形状与失败路径，例如四目标矩阵、签名/SHA、path traversal、staging、active 不变、plugin sync、loader tool call 和普通 command item。
3. 不验证真实 PPT 产品能力，不关闭授权来源、真实 archive、四目标 native load、资源预算、dev/packaged R07 或正式安装介质门禁。
4. 不向生产 manifest/diagnostics 增加 synthetic 专用包身份分支；test-only 输入必须走通用 v2 schema，并由 runner/feed channel 隔离。
5. 不使用宿主 Node、direct Runtime root、app-server 替身、假 registry、预生成 PPT 或降低断言来模拟生产成功。

## 3. 当前产品边界

生产本轮只承诺“新建 PPTX + 自动 QA + 工作区预览”。synthetic lane 不得新增或暗示既有 PPTX 的文本、图片、页面、主题、母版或 round-trip 编辑能力。

## 4. 迁移要求

- 旧 synthetic 测试中对 `@oai/artifact-tool`、OpenAI Presentations、`presentation-engine-v1`、顶层 Runtime `root` 或自定义 loader JSON 的正向断言，必须删除或改为 negative/migration assertion。
- 仍有价值的 synthetic 用例并入主计划 P6 的非发布回归集合；不再从本文件派生实施任务。
- 恢复或扩展本文件前必须先修改主计划并明确新的非生产测试目标；不得以缺少私有 OpenAI 制品为恢复条件。

## 5. 停止条件

本文件没有独立完成状态。synthetic 测试通过只能说明测试 lane 通过，不能说明 Primary Runtime、授权 PPT plugin 或“新建 PPTX + QA + 预览”产品闭环完成。
