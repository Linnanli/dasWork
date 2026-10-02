import { describe, expect, it, vi } from 'vitest'

import { WorkspaceDependenciesFeatureGate } from './WorkspaceDependenciesFeatureGate'

describe('WorkspaceDependenciesFeatureGate', () => {
  it('publishes only for the local host when both product and app-server features are enabled', async () => {
    const listExperimentalFeatures = vi.fn(async () => [
      { name: 'workspace_dependencies', enabled: true }
    ])
    const gate = new WorkspaceDependenciesFeatureGate({
      productFeatureEnabled: true,
      listExperimentalFeatures,
      connectionGeneration: () => 7
    })

    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(true)
    await expect(gate.isEnabled({ hostId: 'remote' })).resolves.toBe(false)
    expect(listExperimentalFeatures).toHaveBeenCalledOnce()
  })

  it('fails closed without querying when the product feature is disabled', async () => {
    const listExperimentalFeatures = vi.fn(async () => [
      { name: 'workspace_dependencies', enabled: true }
    ])
    const gate = new WorkspaceDependenciesFeatureGate({
      productFeatureEnabled: false,
      listExperimentalFeatures,
      connectionGeneration: () => 7
    })

    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(false)
    expect(listExperimentalFeatures).not.toHaveBeenCalled()
  })

  it('shares an in-flight page-complete query for the same host and connection generation', async () => {
    let resolveFeatures:
      | ((features: readonly { name: string; enabled: boolean }[]) => void)
      | undefined
    const listExperimentalFeatures = vi.fn(
      () =>
        new Promise<readonly { name: string; enabled: boolean }[]>((resolve) => {
          resolveFeatures = resolve
        })
    )
    const gate = new WorkspaceDependenciesFeatureGate({
      productFeatureEnabled: true,
      listExperimentalFeatures,
      connectionGeneration: () => 3
    })

    const first = gate.isEnabled({ hostId: 'local' })
    const second = gate.isEnabled({ hostId: 'local' })
    expect(listExperimentalFeatures).toHaveBeenCalledOnce()
    resolveFeatures?.([{ name: 'workspace_dependencies', enabled: true }])

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('clears cache across generation changes and fails closed for errors, stale reads, and timeouts', async () => {
    let generation = 1
    const listExperimentalFeatures = vi
      .fn<() => Promise<readonly { name: string; enabled: boolean }[]>>()
      .mockResolvedValueOnce([{ name: 'workspace_dependencies', enabled: true }])
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => {
        generation = 4
        return [{ name: 'workspace_dependencies', enabled: true }]
      })
      .mockImplementationOnce(() => new Promise(() => undefined))
    const gate = new WorkspaceDependenciesFeatureGate({
      productFeatureEnabled: true,
      listExperimentalFeatures,
      connectionGeneration: () => generation,
      timeoutMs: 1
    })

    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(true)
    generation = 2
    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(false)
    generation = 3
    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(false)
    await expect(gate.isEnabled({ hostId: 'local' })).resolves.toBe(false)
  })
})
