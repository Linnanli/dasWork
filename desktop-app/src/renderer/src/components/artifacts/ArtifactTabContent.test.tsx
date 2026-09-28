// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactPreviewSourceChangeEvent } from '../../../../shared/artifactPreviewApi'
import type { GitConversationTarget } from '../../../../shared/localGitApi'
import { ArtifactConversationBridgeProvider } from './ArtifactConversationBridge'
import { ArtifactTabContent } from './ArtifactTabContent'
import type { ArtifactTabDescriptor } from './artifactTabDescriptor'

vi.mock('./presentation/PresentationRendererAdapter', () => ({
  parsePresentationInWorker: vi.fn(async () => ({
    document: {
      width: 16,
      height: 9,
      slides: Array.from({ length: 6 }, (_, index) => ({
        id: `slide-${index + 1}`,
        number: index + 1,
        name: `第 ${index + 1} 页`,
        elements: []
      }))
    },
    warnings: []
  }))
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('ArtifactTabContent source lifecycle', () => {
  let container: HTMLDivElement
  let root: Root
  let generation: number
  let sourceEvent: ((event: ArtifactPreviewSourceChangeEvent) => void) | undefined
  const sourceId = 'artifact-source-test'
  const slides = Array.from({ length: 6 }, (_, index) => btoa(`page-${index + 1}`))
  const metadata = vi.fn()
  const readBinary = vi.fn()
  const renderPresentation = vi.fn()
  const prepareRoot = vi.fn()
  const registerWorkspaceSource = vi.fn()
  const runtimeChanged = vi.fn()

  beforeEach(() => {
    generation = 1
    sourceEvent = undefined
    prepareRoot.mockReset().mockResolvedValue({ rootId: 'workspace-root' })
    registerWorkspaceSource.mockReset().mockResolvedValue({ sourceId: 'replacement-source' })
    runtimeChanged.mockReset()
    metadata.mockReset().mockImplementation(async ({ sourceId }: { sourceId: string }) => ({
      version: 1,
      sourceId,
      metadata: { name: 'deck.pptx', size: 100, mtimeMs: generation, generation }
    }))
    readBinary.mockReset().mockImplementation(async ({ sourceId }: { sourceId: string }) => ({
      version: 1,
      sourceId,
      content: {
        kind: 'binary',
        encoding: 'base64',
        generation,
        checksum: generation.toString(16).repeat(64),
        base64: btoa('pptx')
      }
    }))
    renderPresentation
      .mockReset()
      .mockImplementation(async ({ sourceId }: { sourceId: string }) => ({
        version: 1,
        sourceId,
        generation,
        slides: slides.map((base64, index) => ({ number: index + 1, base64 }))
      }))
    Object.defineProperty(window, 'desktopApp', {
      configurable: true,
      value: {
        workspace: {
          artifacts: {
            metadata,
            readBinary,
            renderPresentation,
            registerWorkspaceSource,
            onEvent: (listener: typeof sourceEvent) => {
              sourceEvent = listener
              return () => {
                sourceEvent = undefined
              }
            }
          },
          files: { prepareRoot, onEvent: () => () => undefined }
        }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  function Harness({
    navigation,
    relativePath = 'deck.pptx',
    target = { conversationId: 'conversation', threadId: 'thread' }
  }: {
    navigation?: ArtifactTabDescriptor['navigation']
    relativePath?: string
    target?: GitConversationTarget
  }): React.JSX.Element {
    const [focusCount, setFocusCount] = useState(0)
    return (
      <ArtifactConversationBridgeProvider>
        <div
          data-focus-count={focusCount}
          onFocusCapture={() => setFocusCount((count) => count + 1)}
        >
          <ArtifactTabContent
            artifact={{
              id: 'deck',
              title: 'deck.pptx',
              source: { kind: 'workspace-file', relativePath },
              openSource: 'file-workspace',
              navigation
            }}
            workspaceId="workspace"
            target={target}
            runtime={{
              artifactSourceId: sourceId,
              artifactSourceKey: 'workspace:["workspace","deck.pptx","conversation","thread"]'
            }}
            onRuntimeChange={(runtime) => runtimeChanged(runtime)}
          />
        </div>
      </ArtifactConversationBridgeProvider>
    )
  }

  async function nextSlide(): Promise<void> {
    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')
      expect(button).not.toBeNull()
      button!.focus()
      button!.click()
    })
  }

  it('keeps the selected page when panel focus recreates equivalent source props', async () => {
    await act(async () => root.render(<Harness />))
    expect(container.textContent).toContain('1 / 6')
    await nextSlide()
    expect(container.querySelector('[data-focus-count]')?.getAttribute('data-focus-count')).toBe(
      '1'
    )
    expect(container.textContent).toContain('2 / 6')
    expect(container.querySelector('.presentation-stage-image')?.getAttribute('src')).toBe(
      `data:image/png;base64,${slides[1]}`
    )
    expect(metadata).toHaveBeenCalledTimes(1)
    expect(readBinary).toHaveBeenCalledTimes(1)
    expect(renderPresentation).toHaveBeenCalledTimes(1)
  })

  it('reloads an actual source generation change and still honors explicit page navigation', async () => {
    await act(async () => root.render(<Harness />))
    await nextSlide()
    generation = 2
    await act(async () => sourceEvent?.({ version: 1, sourceId }))
    expect(container.textContent).toContain('1 / 6')
    expect(
      container
        .querySelector('[data-artifact-preview-generation]')
        ?.getAttribute('data-artifact-preview-generation')
    ).toBe('2')
    expect(readBinary).toHaveBeenCalledTimes(2)
    expect(renderPresentation).toHaveBeenCalledTimes(2)
    await act(async () =>
      root.render(
        <Harness
          navigation={{ requestId: 'navigate-4', artifactKind: 'presentation', slideNumber: 4 }}
        />
      )
    )
    expect(container.textContent).toContain('4 / 6')
    expect(readBinary).toHaveBeenCalledTimes(2)
    expect(renderPresentation).toHaveBeenCalledTimes(2)
  })

  it('registers a changed file path instead of reusing the previous file authorization', async () => {
    await act(async () => root.render(<Harness />))
    await act(async () => root.render(<Harness relativePath="replacement.pptx" />))
    expect(prepareRoot).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      target: { conversationId: 'conversation', threadId: 'thread' }
    })
    expect(registerWorkspaceSource).toHaveBeenCalledWith({
      version: 1,
      rootId: 'workspace-root',
      path: 'replacement.pptx'
    })
    expect(runtimeChanged).toHaveBeenCalledWith({
      artifactSourceId: 'replacement-source',
      artifactSourceKey: 'workspace:["workspace","replacement.pptx","conversation","thread"]'
    })
    expect(readBinary).toHaveBeenLastCalledWith({ version: 1, sourceId: 'replacement-source' })
    expect(
      container.querySelector('[data-artifact-source-id]')?.getAttribute('data-artifact-source-id')
    ).toBe('replacement-source')
  })

  it.each([
    { conversationId: 'another-conversation', threadId: 'thread' },
    { conversationId: 'conversation', threadId: 'another-thread' }
  ])('registers the same workspace path again when the target changes to %j', async (target) => {
    await act(async () => root.render(<Harness />))
    expect(registerWorkspaceSource).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness target={target} />))
    expect(prepareRoot).toHaveBeenCalledWith({ workspaceId: 'workspace', target })
    expect(registerWorkspaceSource).toHaveBeenCalledWith({
      version: 1,
      rootId: 'workspace-root',
      path: 'deck.pptx'
    })
    expect(readBinary).toHaveBeenLastCalledWith({ version: 1, sourceId: 'replacement-source' })
    expect(runtimeChanged).toHaveBeenCalledWith({
      artifactSourceId: 'replacement-source',
      artifactSourceKey: `workspace:${JSON.stringify(['workspace', 'deck.pptx', target.conversationId, target.threadId])}`
    })
  })
})
