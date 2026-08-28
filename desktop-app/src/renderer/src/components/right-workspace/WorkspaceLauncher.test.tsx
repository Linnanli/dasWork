// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RightWorkspaceProvider } from './RightWorkspaceProvider'
import { WorkspaceLauncher } from './WorkspaceLauncher'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('WorkspaceLauncher', () => {
  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  it('uses compact, distinct surfaces for workspace actions', async () => {
    await act(async () => {
      root.render(
        <RightWorkspaceProvider projectScope="workspace-launcher-test">
          <WorkspaceLauncher />
        </RightWorkspaceProvider>
      )
    })

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(10)
    for (const button of buttons) {
      expect(button.dataset.slot).toBe('button')
      expect(button.dataset.variant).toBe('secondary')
      expect(button.dataset.size).toBe('sm')
      expect(button.className).toContain('h-8')
      expect(button.className).not.toContain('border-border')
      expect(button.className).toContain('bg-secondary')
    }
  })
})
