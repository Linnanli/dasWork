# Reference Electron Analysis Workflow

This workflow keeps extracted Electron package analysis cheap without lowering the evidence bar.

## Generated Artifacts

- `_analysis/raw/`: exact pre-format text mirror created by the extract script. Use it for original package line and column provenance when present.
- `_analysis/reference-index/files.jsonl`: file layer, readable hash, raw hash, line counts, source map hints.
- `_analysis/reference-index/imports.jsonl`: static imports, dynamic imports, `require`, HTML/CSS asset references, readable and raw locations.
- `_analysis/reference-index/search.sqlite`: searchable strings, identifiers, regex literals, paths and imports, with bounded occurrence samples.
- `_analysis/semantic-slices/<name>/`: byte-identical readable copies for LSP/code-review-graph analysis, with `provenance.json` mapping back to original files.

## Recommended Commands

Build or refresh an index:

```sh
npm --prefix desktop-app run reference:chatgpt:index -- --root reference-projects/codex-electron-26.818.21641-beautified
```

Compact query:

```sh
npm --prefix desktop-app run reference:chatgpt:query -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --term sandbox --limit 8
```

For UI work, include at least one target-identity anchor such as an entry label, route fragment, mode prop/state, or owning container. Use this first query only to rank candidates; do not request source context yet.

Bounded context:

```sh
npm --prefix desktop-app run reference:chatgpt:query -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --context 1 --limit 3
```

Any query with `--context` must use `--limit 3` or lower. The script rejects larger context-bearing result sets even though a context-free candidate query permits up to 8 results.

Slice for semantic tools:

```sh
npm --prefix desktop-app run reference:chatgpt:slice -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --name approval --depth 1 --max-files 30
```

Optionally build code-review-graph inside the slice:

```sh
npm --prefix desktop-app run reference:chatgpt:slice -- --root reference-projects/codex-electron-26.818.21641-beautified --term approval --name approval --depth 1 --max-files 30 --graph
```

## Acceptance Bar

- Query first, source second: broad scans should return compact candidate metadata before any source window is read.
- Identity before behavior: for page-scoped UI work, connect the requested entry/route/mode to its rendered branch before analyzing data loading, ordering, or caching.
- Accuracy stays source-backed: confirmed conclusions need source evidence, not just index hits.
- Test the requested surface: runtime evidence must navigate through the target entry instead of a similarly named neighboring page.
- Traceability is mandatory: every cited source location must include line number and hash provenance.
- Current package note: if a reference was extracted before `_analysis/raw/` existed, treat it as beautified fallback until it is re-extracted or a raw mirror is restored.
