import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DesktopHostCapabilityRuntime } from '../appTools/DesktopHostCapabilityRuntime'
import { readPrimaryRuntimeBundledPluginDescriptors } from '../bundledPlugins'
import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'
import type { WorkspaceDependencyLoadResult } from './primaryRuntimeTypes'

const configuredRuntimeRoot = process.env.DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT
const realRuntimeSmokeEnabled = process.env.DASCOWORK_REAL_PRIMARY_RUNTIME_SMOKE === '1'

describe.skipIf(!realRuntimeSmokeEnabled)('Primary Runtime real integration', () => {
  it('loads dependencies through the desktop tool and discovers the real plugin marketplace', async () => {
    expect(
      configuredRuntimeRoot,
      'real Runtime gate requires an explicit Runtime root'
    ).toBeTruthy()
    const runtimeRoot = await realpath(configuredRuntimeRoot!)
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({
        env: { DASCOWORK_PRIMARY_RUNTIME_ROOT: runtimeRoot },
        allowDevelopmentRoot: true,
        appCacheRoot: '/primary-runtime-real-smoke-unused-cache'
      })
    })
    let toolLoadCount = 0
    const capabilities = new DesktopHostCapabilityRuntime({
      workspaceDependencies: {
        diagnoseDependencies: () => service.diagnoseDependencies(),
        async loadDependencies() {
          toolLoadCount += 1
          return service.loadDependencies()
        }
      }
    })

    const diagnostic = await service.diagnoseDependencies()
    expect(diagnostic).toMatchObject({
      status: 'ready',
      root: runtimeRoot,
      manifest: { bundleFormatVersion: 2 }
    })

    const snapshot = await capabilities.snapshot()
    expect(snapshot.availableToolNames).toContain('load_workspace_dependencies')

    const result = await capabilities.dispatch({
      namespace: 'codex_app',
      tool: 'load_workspace_dependencies',
      arguments: {},
      threadId: 'primary-runtime-real-smoke'
    })
    expect(result.success).toBe(true)
    expect(toolLoadCount).toBe(1)

    const text = result.contentItems.find((item) => item.type === 'inputText')?.text
    expect(text).toBeTruthy()
    const dependencies = JSON.parse(text!) as WorkspaceDependencyLoadResult
    expect(dependencies.root).toBe(runtimeRoot)
    expect(dependencies.bundleVersion).toBe(diagnostic.manifest?.bundleVersion)
    expect(dependencies.nodePackages.map((entry) => entry.name)).toContain('@oai/artifact-tool')
    expectRuntimePath(runtimeRoot, dependencies.node)
    expectRuntimePath(runtimeRoot, dependencies.nodeModules)
    if (dependencies.python) expectRuntimePath(runtimeRoot, dependencies.python)
    for (const binary of Object.values(dependencies.binaries)) {
      expectRuntimePath(runtimeRoot, binary)
    }

    const descriptors = await readPrimaryRuntimeBundledPluginDescriptors(diagnostic)
    expect(descriptors.map((descriptor) => descriptor.pluginName)).toEqual(
      expect.arrayContaining(['presentations', 'documents'])
    )
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({ sourceKind: 'primary-runtime', internal: true })
      expectRuntimePath(runtimeRoot, descriptor.marketplacePath)
      expectRuntimePath(runtimeRoot, descriptor.pluginRoot)
    }
  })
})

function expectRuntimePath(runtimeRoot: string, candidate: string): void {
  expect(isAbsolute(candidate)).toBe(true)
  const difference = relative(runtimeRoot, candidate)
  expect(difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))).toBe(true)
}
