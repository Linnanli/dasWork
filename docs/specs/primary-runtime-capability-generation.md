# Primary Runtime capability state

`PrimaryRuntimeCapabilityPolicy` is a Main-owned observation cache. It records
the last Runtime diagnostic and whether the Runtime-owned plugin marketplace and
skills have synchronized successfully. Its revision is an in-process UI/cache
marker, not a Runtime protocol generation and not an admission condition.

- New local threads publish `load_workspace_dependencies` only when the local
  product and app-server feature gates allow it and the observed Runtime is
  healthy. Missing, installing, or broken Runtime recovery remains a Plugin
  Center responsibility and does not publish an unusable dynamic tool.
- When the Runtime is healthy, workspace instructions may direct the model to
  the loader's path-only result. `presentation-skill` becomes usable after its
  marketplace/skill synchronization and `skills/list { forceReload: true }`.
- Thread-start `dynamicTools` remain immutable. Resuming an existing thread
  does not receive an invented tool or a Runtime-specific rejection gate.
- Runtime-owned plugins are identified as `primary-runtime:<bundleVersion>`;
  their replacement desired set may retire logical plugin IDs that disappeared,
  but must not disable a replacement with the same plugin ID or modify user
  plugins.
