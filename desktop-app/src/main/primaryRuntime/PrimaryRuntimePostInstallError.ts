export type PrimaryRuntimePostInstallStage = 'sync_plugins' | 'sync_skills' | 'reload_skills'

/**
 * Main-only error carrying the safe post-install phase. Its message remains
 * diagnostic-only; renderer-facing status derives a fixed code and wording.
 */
export class PrimaryRuntimePostInstallError extends Error {
  constructor(
    readonly stage: PrimaryRuntimePostInstallStage,
    message: string
  ) {
    super(message)
    this.name = 'PrimaryRuntimePostInstallError'
  }
}
