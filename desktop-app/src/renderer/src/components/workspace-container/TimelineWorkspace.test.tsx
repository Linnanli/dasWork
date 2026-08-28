// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TimelineWorkspace } from './TimelineWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('TimelineWorkspace', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders ordered conversation and activity events', async () => {
    await act(async () => {
      root.render(
        <TimelineWorkspace
          events={[
            { id: 'user', type: 'user', label: '检查工作台' },
            { id: 'activity', type: 'activity', label: '已运行 2 个命令', status: '已完成' },
            { id: 'agent', type: 'subagent', label: 'Review：正在工作' }
          ]}
        />
      )
    })

    const events = container.querySelectorAll('[data-slot="workspace-timeline-event"]')
    expect(events).toHaveLength(3)
    expect(events[0]?.getAttribute('data-event-type')).toBe('user')
    expect(events[1]?.textContent).toContain('已完成')
    expect(events[2]?.getAttribute('data-event-type')).toBe('subagent')
  })
})
