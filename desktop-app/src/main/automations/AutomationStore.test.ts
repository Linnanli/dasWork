import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ScheduledAutomation } from '../../shared/automationApi'
import { AutomationStore } from './AutomationStore'

describe('AutomationStore', () => {
  it('writes an automation atomically and restores it after a restart', async () => {
    await withTemporaryDirectory(async (directory) => {
      const filePath = join(directory, 'automations.json')
      const store = AutomationStore.onDisk(filePath)
      await store.set([automationFixture()])

      const restarted = AutomationStore.onDisk(filePath)
      await expect(restarted.load()).resolves.toEqual([automationFixture()])
    })
  })

  it('ignores invalid persisted data instead of exposing it to the renderer', async () => {
    await withTemporaryDirectory(async (directory) => {
      const filePath = join(directory, 'automations.json')
      await writeFile(filePath, JSON.stringify([{ ...automationFixture(), title: '' }]), 'utf8')

      const store = AutomationStore.onDisk(filePath)
      await expect(store.load()).resolves.toEqual([])
    })
  })
})

function automationFixture(): ScheduledAutomation {
  return {
    id: 'automation-1',
    sourceConversationId: 'conversation-1',
    sourceThreadId: 'thread-1',
    sourceProjectSelection: { projectKind: 'local', projectId: 'project-1' },
    title: 'Daily report',
    prompt: 'Create the daily report.',
    schedule: { kind: 'daily', time: '09:00' },
    status: 'active',
    createdAt: '2026-08-28T08:00:00.000Z',
    updatedAt: '2026-08-28T08:00:00.000Z',
    nextRunAt: '2026-08-29T01:00:00.000Z',
    runs: []
  }
}

async function withTemporaryDirectory(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-automations-'))
  try {
    await work(directory)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}
