---
name: reference-electron-analysis
description: Analyze extracted ChatGPT/Codex Electron packages under reference-projects with the repository's low-token index, exact readable-file SHA/line evidence, optional pre-format raw line/column provenance, bounded LSP slices, and scoped code-review-graph. Use whenever a turn asks to inspect, compare, trace, or explain behavior from an Electron reference project or a newly extracted app.asar package.
---

# Electron reference analysis

Use the repository scripts instead of opening large bundles or calling broad graph-overview tools first.

## Required workflow

1. Locate the requested reference root. When the version is unspecified, the scripts select the newest `reference-projects/codex-electron-*-beautified` directory.
2. Run a full inventory and hash integrity check:

   `npm --prefix desktop-app run reference:chatgpt:validate -- [--root <path>]`

   If the index is missing or stale, rebuild it with `reference:chatgpt:index` before analysis.
3. Establish the target surface before searching for its behavior. Derive identity anchors from the user-visible entry label, route or path, mode prop/state, and owning component or container. When similarly named browse, manage, settings, and detail surfaces coexist, connect the entry/route/mode setter to the rendered branch and record the adjacent surfaces that are out of scope.
4. Translate the requested behavior into 2-5 likely English code anchors. Query paths, imports, identifiers, strings, and regex literals with no source context first:

   `npm --prefix desktop-app run reference:chatgpt:query -- --term <anchor> [--term <anchor>] --limit 8 [--root <path>]`

5. Request bounded context only for the best candidates. A query that includes `--context` must also use `--limit 3` or lower; `--limit 8` is only for the context-free candidate query. Use `--context 0` for one exact line or at most `--context 3`. Do not dump whole chunks.

   `npm --prefix desktop-app run reference:chatgpt:query -- --term <anchor> --context 3 --limit 3 [--root <path>]`

6. For a cross-file question, materialize an exact-byte semantic slice:

   `npm --prefix desktop-app run reference:chatgpt:slice -- --term <anchor> --name <topic> --depth 1 --max-files 30 [--graph] [--root <path>]`

   Use LSP/TypeScript navigation on the generated slice when available. Use `code-review-graph` only on that bounded slice. The pre-existing full reference graph may supplement analysis of `external/`, but it does not cover the core `.vite/build` and `webview/assets` bundles reliably.
7. Read the original reference paths named by `provenance.json` before reporting behavior. A semantic-slice path is never the final citation.

## Evidence gate

Follow [references/evidence-policy.md](references/evidence-policy.md). See [references/workflow.md](references/workflow.md) for the generated artifacts and command examples. In particular:

- Treat index and graph results as candidate routing, not proof.
- For a page-scoped UI claim, first prove target identity with an entry/route/mode observation connected to the matching rendered branch. Evidence from a neighboring browse, manage, settings, or detail surface does not establish the requested target.
- Confirm a behavior with at least two connected source observations, such as registration plus consumer, event emission plus handler, or state write plus rendered branch. A targeted runtime test can replace one observation.
- A targeted runtime test must enter the exact surface through the user-specified path. A passing test for an adjacent surface cannot replace target identity evidence.
- Cite the readable reference file and exact line. When `sourceMode` is `raw-mirror`, also record the pre-format raw line and column. When it is `beautified-fallback`, say that the archived pre-format package is unavailable; do not invent raw positions.
- Stop broad retrieval after the behavior is proven. Default caps are 8 context-free candidates, 3 total context windows, 3 context lines, depth 1, and 30 slice files.

## New package versions

Run:

`npm --prefix desktop-app run reference:chatgpt -- --force`

The extractor now preserves `_analysis/raw/` before Prettier and automatically builds `_analysis/reference-index/`. Never format or rewrite `_analysis/raw/`. If the package ships source maps, prefer them and preserve their mapping; otherwise raw line/column plus readable-line evidence is the traceability boundary.

## Failure handling

- On a stale hash error, rebuild the index; never bypass the error with an unverified excerpt.
- If results span similarly named surfaces, narrow with entry labels, route fragments, mode props/state, or container names before inspecting behavior. Do not choose a surface from shared feature vocabulary alone.
- If a query has no useful result, add synonyms or a concrete UI/IPC/error string, then use a tightly capped `rg -n` search. Do not fall back to reading the entire bundle.
- Localization bundles are deliberately routed to the bounded `rg` fallback to keep translated duplicates out of normal results.
- If the bounded slice hits 30 files, narrow the anchors or start from explicit `--file` seeds instead of increasing the cap immediately.
