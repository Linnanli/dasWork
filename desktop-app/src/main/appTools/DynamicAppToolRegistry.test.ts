import { describe, expect, it } from 'vitest'

import { DynamicAppToolRegistry, type DynamicAppToolDefinition } from './DynamicAppToolRegistry'

function definition(overrides: Partial<DynamicAppToolDefinition> = {}): DynamicAppToolDefinition {
  return {
    namespace: 'codex_app',
    name: 'echo',
    description: 'Echo the provided arguments.',
    inputSchema: { type: 'object' },
    exposure: { native: true, pipe: true },
    availability: async () => ({ state: 'available' }),
    execute: async (_context, argumentsValue) => ({
      success: true,
      contentItems: [{ type: 'inputText', text: JSON.stringify(argumentsValue) }]
    }),
    ...overrides
  }
}

describe('DynamicAppToolRegistry', () => {
  it('projects a single codex_app namespace from the registered definitions', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(definition())
    registry.register(definition({ name: 'second', description: 'A second tool.' }))

    await expect(registry.nativeProjection({ hostId: 'local' })).resolves.toEqual([
      {
        type: 'namespace',
        name: 'codex_app',
        description: 'Desktop-hosted tools available in the local Codex application.',
        tools: [
          {
            type: 'function',
            name: 'echo',
            description: 'Echo the provided arguments.',
            inputSchema: { type: 'object' }
          },
          {
            type: 'function',
            name: 'second',
            description: 'A second tool.',
            inputSchema: { type: 'object' }
          }
        ]
      }
    ])
    await expect(registry.pipeProjection({ hostId: 'local' })).resolves.toEqual([
      expect.objectContaining({ name: 'echo', namespace: 'codex_app' }),
      expect.objectContaining({ name: 'second', namespace: 'codex_app' })
    ])
  })

  it('rejects duplicate namespace/name definitions during startup', () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(definition())

    expect(() => registry.register(definition())).toThrow('codex_app')
  })

  it('does not publish or execute unavailable definitions', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(
      definition({
        availability: async () => ({ state: 'unavailable', reason: 'Runtime is unavailable.' })
      })
    )

    await expect(registry.nativeProjection({ hostId: 'local' })).resolves.toEqual([])
    await expect(
      registry.dispatch({ namespace: 'codex_app', tool: 'echo', arguments: {} })
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Runtime is unavailable.' }]
    })
  })

  it('fails closed when an availability probe throws', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(
      definition({ availability: async () => Promise.reject(new Error('diagnostic failed')) })
    )

    await expect(registry.nativeProjection({ hostId: 'local' })).resolves.toEqual([])
    await expect(registry.dispatch({ tool: 'echo' })).resolves.toMatchObject({ success: false })
  })

  it('routes generated-protocol tool/namespace/arguments fields through the shared dispatcher', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(definition())

    await expect(
      registry.dispatch({
        namespace: 'codex_app',
        tool: 'echo',
        arguments: { answer: 42 },
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1'
      })
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: '{"answer":42}' }]
    })
  })

  it('rejects null arguments instead of treating them as an empty object', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(definition())

    await expect(
      registry.dispatch({
        namespace: 'codex_app',
        tool: 'echo',
        arguments: null
      })
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Tool arguments must be an object.' }]
    })
  })

  it('fails closed for an unknown namespace or a cancelled request', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(definition())
    const controller = new AbortController()
    controller.abort()

    await expect(registry.dispatch({ namespace: 'other', tool: 'echo' })).resolves.toMatchObject({
      success: false
    })
    await expect(
      registry.dispatch({ namespace: 'codex_app', tool: 'echo' }, controller.signal)
    ).resolves.toMatchObject({
      success: false,
      contentItems: [{ text: 'Dynamic tool call was cancelled.' }]
    })
  })
})
