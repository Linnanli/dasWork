# Reference evidence policy

## Evidence levels

| Level              | Meaning                                                                     | Allowed use                                              |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Candidate          | Index hit, graph node, LSP symbol, decompiler output                        | Choose what to inspect next                              |
| Source observation | Exact readable path, SHA256, line and nearby branch/call                    | Support one part of a claim                              |
| Raw observation    | Pre-format mirror SHA256, line, column and matching token/string            | Trace a source observation back to the extracted package |
| Confirmed behavior | Two connected source observations, or source plus targeted runtime evidence | State behavior as fact                                   |

`beautified-fallback` means an older reference was formatted before this workflow existed and its matching archived `app.asar` is unavailable. Its readable line remains exact for that local reference tree, but it is not a pre-format raw position.

`partial-raw-mirror` means only some indexed files have pre-format mirrors. Report each file with raw evidence as `raw-mirror` and every file without it as `beautified-fallback`.

## Target identity gate

For page-scoped UI behavior, prove which surface is under analysis before using data-loading, sorting, caching, or rendering evidence:

1. Observe the user-facing entry, route/path, or mode state that selects the target.
2. Connect it to the component or rendered branch that consumes the same route/mode.
3. Name similarly labeled neighboring surfaces that are excluded when the distinction affects the conclusion.

A runtime test may support this gate only when it navigates through the requested entry and asserts the target surface. A passing browse-page test is not evidence for a manage page, and the reverse is also true.

## Accuracy rules

1. Verify each candidate file hash before showing context.
2. Keep readable and raw coordinates separate; Prettier can change line numbers.
3. Do not infer original TypeScript names, module boundaries, types, or comments when source maps are absent.
4. Do not use a graph edge as the only proof of a call path. Inspect both endpoints and the surrounding condition or payload.
5. For version comparisons, build and validate a separate index per version. Never reuse line numbers across versions.
6. Derived semantic slices must copy readable bytes exactly and retain `provenance.json`; they may improve navigation but never replace original-path citations.
7. Do not combine observations from different UI surfaces into one behavior claim unless the source proves that they share the same implementation path.

## Compact reporting shape

For each confirmed behavior, report:

- conclusion;
- target identity evidence for page-scoped UI claims;
- readable reference `path:line`;
- raw `path:line:column` when available;
- the second connected observation or runtime evidence;
- any remaining inference, explicitly labeled.
