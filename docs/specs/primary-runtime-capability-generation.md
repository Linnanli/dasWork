# Primary Runtime capability state

`PrimaryRuntimeCapabilityPolicy` is a Main-owned observation cache. It records
the last Runtime diagnostic and whether the Runtime-owned plugin marketplace and
skills have synchronized successfully. Its revision is an in-process UI/cache
marker, not a Runtime protocol generation and not an admission condition.

- New local threads publish `load_workspace_dependencies` whenever the local
  product and app-server feature gates allow it. A missing or broken Runtime
  returns a stable failure; it does not change the tool schema.
- When a Runtime is healthy, workspace instructions may direct the model to the
  loader's path-only result. `presentation-skill` becomes usable after its
  marketplace/skill synchronization and `skills/list { forceReload: true }`.
- Thread-start `dynamicTools` remain immutable. Resuming an existing thread
  does not receive an invented tool or a Runtime-specific rejection gate.
- Runtime-owned plugins are identified as `primary-runtime:<bundleVersion>`;
  their replacement desired set may retire obsolete Runtime-owned plugins but
  must not modify user plugins.
