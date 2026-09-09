export type BundledPluginReconcileCoordinatorInput = {
  reconcile(): Promise<void>
  refreshCapabilities(): void
  onFailure(error: unknown): void
  warn(message: string, error: unknown): void
}

export class BundledPluginReconcileCoordinator {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly input: BundledPluginReconcileCoordinatorInput) {}

  run(reason: string): Promise<void> {
    const task = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.input.reconcile()
        } catch (error) {
          this.input.onFailure(error)
          this.input.warn(`[bundled-plugins] reconcile failed after ${reason}`, error)
        } finally {
          this.input.refreshCapabilities()
        }
      })

    this.tail = task
    return task
  }
}
