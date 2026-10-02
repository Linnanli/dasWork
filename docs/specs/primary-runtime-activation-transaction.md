# Primary Runtime activation transaction

The Main process journals only Runtime publication:

1. Prepare an immutable candidate: download, SHA check, streamed extraction and diagnostics.
2. Persist `prepared` with the previous active pointer.
3. Publish the active pointer, then read back active Runtime diagnostics.
4. Persist `committed` and remove the journal.

If pointer publication or active readback fails, Main restores the previous pointer
(or clears a first install). An interrupted `prepared`, `pointer-committed`, or
`readback` journal is recovered in the same way on the next startup. A failed
pointer recovery leaves the journal in place for a later retry.

After Runtime publication succeeds, the separate app-server catalog workflow
synchronizes the Runtime-owned plugin marketplace and skills, then requests
`skills/list { forceReload: true }`. That workflow decides whether the install
operation can report success and is retryable through repair; it is not staged
inside the pointer transaction and does not block or rewrite existing thread
snapshots.
