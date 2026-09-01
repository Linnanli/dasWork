# Electron 参考项目低 token 分析流程

目标：分析 `reference-projects/codex-electron-*-beautified` 时先用索引缩小范围，再读少量源码窗口；所有结论都能追溯到原文件行号和 SHA256。未指定 `--root` 时，命令会选择版本号最新的参考项目。

运行环境要求 Node.js 22.5 或更高版本；索引查询依赖 Node 内置的 SQLite。

## 生成

重新解包会自动生成 raw 镜像和索引：

```sh
npm --prefix desktop-app run reference:chatgpt -- --force
```

只重建已有解包目录的索引：

```sh
npm --prefix desktop-app run reference:chatgpt:index -- --root reference-projects/codex-electron-26.818.21641-beautified
```

## 查询

默认只返回最多 8 个候选，不带源码正文，适合低 token 定位：

```sh
npm --prefix desktop-app run reference:chatgpt:query -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --term sandbox
```

候选足够窄后再带源码窗口：

```sh
npm --prefix desktop-app run reference:chatgpt:query -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --context 1 --limit 3
```

## LSP / code-review-graph

不要对整个解包目录建语义图。先切出小语料：

```sh
npm --prefix desktop-app run reference:chatgpt:slice -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --name approval --depth 1 --max-files 30
```

需要时再对 `_analysis/semantic-slices/<name>/` 使用 LSP，或给命令增加 `--graph`，只在这个切片中运行 `code-review-graph`。切片里的文件是 readable 版本的字节级复制，`provenance.json` 会记录原始来源、readable hash 和 raw hash。

已有参考项目根目录下的 `.code-review-graph` 仍可辅助分析 `external/` 插件和 Skill，但它没有可靠覆盖 `.vite/build/` 与 `webview/assets/`，不能作为桌面核心行为的完整图。

## 准确率规则

- `_analysis/reference-index/` 只负责找候选，不单独作为行为结论。
- readable 文件用于审阅和最终原路径引用；有 `_analysis/raw/` 时，还要给出排版前原包的 raw 行、列和 SHA256。
- 旧解包目录没有 `_analysis/raw/` 时，必须声明是 `beautified-fallback`，行号只能追溯到排版后的 readable 文件。
- raw 镜像只覆盖部分文件时，索引整体标记为 `partial-raw-mirror`；缺少 raw 的单个候选仍必须标记为 `beautified-fallback`。
- 跨文件行为结论至少要有定义侧和消费侧证据。
- 每次分析前先跑完整的 `reference:chatgpt:validate`；stale 时重建索引。
- 图节点、LSP 跳转和语义切片只负责导航，不能单独作为最终证据。
