import { describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeCapabilityPolicy } from './PrimaryRuntimeCapabilityPolicy'

describe('PrimaryRuntimeCapabilityPolicy', () => {
  it('publishes the loader independently and enables presentation work after plugin synchronization', async () => {
    const policy = new PrimaryRuntimeCapabilityPolicy(true)
    expect(await policy.snapshot()).toMatchObject({
      loaderPublished: true,
      workspaceInstructionsEnabled: false,
      presentationsEligible: false
    })

    const state = policy.update({
      diagnostic: {
        status: 'ready',
        manifest: {
          bundleFormatVersion: 2,
          bundleVersion: 'v2',
          target: { platform: process.platform, arch: process.arch },
          node: { path: 'dependencies/node/bin/node' },
          nodePackages: []
        },
        issues: []
      },
      runtimePluginsSynchronized: true
    })
    expect(state).toMatchObject({
      workspaceInstructionsEnabled: true,
      presentationsEligible: true,
      runtimePluginsSynchronized: true
    })
  })

  it('uses the Main-owned app-server gate for loader publication and invalidates it on demand', async () => {
    let enabled = false
    const invalidate = vi.fn()
    const policy = new PrimaryRuntimeCapabilityPolicy({
      productFeatureEnabled: true,
      loaderFeatureGate: {
        isEnabled: async () => enabled,
        invalidate
      }
    })
    policy.update({
      diagnostic: {
        status: 'ready',
        manifest: {
          bundleFormatVersion: 2,
          bundleVersion: 'v2',
          target: { platform: process.platform, arch: process.arch },
          node: { path: 'dependencies/node/bin/node' },
          nodePackages: []
        },
        issues: []
      },
      runtimePluginsSynchronized: true
    })

    await expect(policy.snapshot()).resolves.toMatchObject({
      loaderPublished: false,
      workspaceInstructionsEnabled: false,
      presentationsEligible: true
    })

    enabled = true
    policy.invalidateLoaderFeatureCache()
    await expect(policy.snapshot()).resolves.toMatchObject({
      loaderPublished: true,
      workspaceInstructionsEnabled: true
    })
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('requires synchronized skills before publishing the v3 OfficeCLI loader', async () => {
    const policy = new PrimaryRuntimeCapabilityPolicy(true)
    policy.update({
      diagnostic: {
        status: 'ready',
        manifest: {
          bundleFormatVersion: 3,
          bundleVersion: 'v3',
          target: { platform: process.platform, arch: process.arch },
          binaries: [{ name: 'officecli', path: 'bin/officecli', required: true }],
          bundledSkills: [{ path: 'skills/officecli/SKILL.md', sha256: 'a'.repeat(64) }]
        },
        issues: []
      },
      runtimePluginsSynchronized: false
    })

    await expect(policy.snapshot()).resolves.toMatchObject({
      loaderPublished: false,
      workspaceInstructionsEnabled: false,
      presentationsEligible: false
    })

    policy.update({
      diagnostic: {
        status: 'ready',
        manifest: {
          bundleFormatVersion: 3,
          bundleVersion: 'v3',
          target: { platform: process.platform, arch: process.arch },
          binaries: [{ name: 'officecli', path: 'bin/officecli', required: true }],
          bundledSkills: [{ path: 'skills/officecli/SKILL.md', sha256: 'a'.repeat(64) }]
        },
        issues: []
      },
      runtimePluginsSynchronized: true
    })

    await expect(policy.snapshot()).resolves.toMatchObject({
      loaderPublished: true,
      workspaceInstructionsEnabled: true,
      presentationsEligible: true
    })
  })
})
