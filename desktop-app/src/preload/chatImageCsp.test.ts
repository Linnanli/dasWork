import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DesktopCodexApi } from '../shared/codexIpcApi'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    postMessage: vi.fn()
  }
}))
vi.mock('electron', () => electron)

let codex: DesktopCodexApi
beforeAll(async () => {
  // Run the actual preload API construction. Shared Zod schemas are created
  // before index.ts configures global jitless, as they are in Electron.
  const rendererWindow: {
    desktopApp?: { codex: DesktopCodexApi }
    addEventListener: ReturnType<typeof vi.fn>
  } = { addEventListener: vi.fn() }
  vi.stubGlobal('window', rendererWindow)
  await import('./index')
  codex = rendererWindow.desktopApp!.codex
})
afterAll(() => vi.unstubAllGlobals())

describe('chat image preload under a strict CSP', () => {
  it('validates resolve and save requests/results with string code generation disabled', async () => {
    electron.ipcRenderer.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'codex:resolve-image-source') {
        return { status: 'available', displaySrc: 'app://fs/@fs/images/one.png' }
      }
      return { status: 'saved', path: '/saved/one.png' }
    })
    const forbiddenFunction = vi
      .spyOn(globalThis, 'Function')
      .mockImplementation(function (): never {
        throw new EvalError('Code generation from strings disallowed for this context')
      })
    try {
      const input = { source: '/images/one.png', sourceKind: 'native-path' } as const
      expect(await codex.resolveImageSource(input)).toEqual({
        status: 'available',
        displaySrc: 'app://fs/@fs/images/one.png'
      })
      expect(await codex.saveImage({ ...input, fileName: 'one.png' })).toEqual({
        status: 'saved',
        path: '/saved/one.png'
      })
      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('codex:resolve-image-source', input)
      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('codex:save-image', {
        ...input,
        fileName: 'one.png'
      })
      expect(forbiddenFunction).not.toHaveBeenCalled()
    } finally {
      forbiddenFunction.mockRestore()
    }
  })

  it('still rejects untrusted payload/result fields without using eval', async () => {
    const forbiddenFunction = vi
      .spyOn(globalThis, 'Function')
      .mockImplementation(function (): never {
        throw new EvalError('Code generation from strings disallowed for this context')
      })
    try {
      await expect(
        codex.resolveImageSource({
          source: '/images/one.png',
          sourceKind: 'native-path',
          cwd: '/renderer'
        } as never)
      ).rejects.toThrow()
      await expect(
        codex.saveImage({
          source: '/images/one.png',
          sourceKind: 'native-path',
          path: '/arbitrary.png'
        } as never)
      ).rejects.toThrow()
      electron.ipcRenderer.invoke.mockResolvedValue({
        status: 'saved',
        path: '/saved/one.png',
        rawRpc: true
      })
      await expect(
        codex.saveImage({ source: '/images/one.png', sourceKind: 'native-path' })
      ).rejects.toThrow()
      expect(forbiddenFunction).not.toHaveBeenCalled()
    } finally {
      forbiddenFunction.mockRestore()
    }
  })
})
