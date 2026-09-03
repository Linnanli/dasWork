# Artifact PPTX renderer decision

## Decision

Artifact PPTX previews use the repository-owned, read-only OOXML adapter in
`src/renderer/src/components/artifacts/presentation/presentation.worker.ts`.
It runs in a same-origin module Worker and produces the application-owned
`PresentationDocument` model used by `PresentationPanel` and the annotation
layer.

## Why not a third-party renderer

The Phase 0 package review checked `@file-viewer/renderer-pptx` 3.0.0 and its
public engine APIs. They provide page rendering and zoom callbacks, but do not
publish a stable slide/object model, object geometry, targetable element IDs,
or an annotation-safe hit-test contract. Those missing public contracts would
make object navigation and element/region annotations depend on private DOM.

The adapter is therefore the third route in the plan: it exposes stable slide
IDs from `p:sldId/@id`, stable object IDs from `p:cNvPr/@id`, and normalised
frames from the public OOXML drawing coordinates. The user interface stays
owned by this application rather than by a third-party DOM.

## Security and offline boundaries

- `jszip@3.10.1` is used under its MIT option; `fast-xml-parser@5.11.1` is MIT.
- The parser is entirely local. It does not load a CDN worker, contact a
  conversion service, or execute presentation macros, scripts, media, or notes.
- Before OOXML parsing, the Worker rejects multi-disk ZIPs, more than 2,000
  entries, path traversal, entries over 32 MiB, totals over 128 MiB, and
  compression ratios over 100:1.
- Only user-clicked `http:` and `https:` hyperlinks leave the panel. Other
  relationship targets and schemes are not executed.
- Main-process Artifact reads are capped at 40 MiB with an actual `limit + 1`
  read, and source identity is rechecked before bytes leave main.

## Supported fidelity matrix

The initial adapter renders text (including Chinese), basic shapes, images,
tables, basic chart placeholders, slide/object navigation, zoom, and
annotations. SmartArt, embedded fonts, animations, macros, speaker notes,
embedded video, encrypted documents, and unsupported drawing primitives show
the standard error/system-open fallback rather than pretending to be editable
or fully faithful PowerPoint output.
