export type BundledPluginReconcileContext = {
  reason: string
  cleanupRuntimeSkills?: boolean
}

export type BundledPluginReconcileCoordinatorInput = {
  reconcile(context: BundledPluginReconcileContext): Promise<void>
  refreshCapabilities(): void
  onFailure(error: unknown): void
  warn(message: string, error: unknown): void
}

export class BundledPluginReconcileCoordinator {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly input: BundledPluginReconcileCoordinatorInput) {}

  run(
    reason: string,
    {
      propagateFailure = false,
      cleanupRuntimeSkills = false
    }: { propagateFailure?: boolean; cleanupRuntimeSkills?: boolean } = {}
  ): Promise<void> {
    const task = this.tail
      .catch(() => undefined)
      .then(() => this.runOnce(reason, propagateFailure, cleanupRuntimeSkills))

    this.tail = task
    return task
  }

  private async runOnce(
    reason: string,
    propagateFailure: boolean,
    cleanupRuntimeSkills: boolean
  ): Promise<void> {
    try {
      await this.input.reconcile({
        reason,
        ...(cleanupRuntimeSkills ? { cleanupRuntimeSkills } : {})
      })
    } catch (error) {
      this.input.onFailure(error)
      this.input.warn(`[bundled-plugins] reconcile failed after ${reason}`, error)
      if (propagateFailure) throw error
    } finally {
      this.input.refreshCapabilities()
    }
  }
}
