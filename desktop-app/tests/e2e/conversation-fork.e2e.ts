import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  appRoot,
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  launchApp
} from './support/app'
import { createLocalProject } from './support/chatActions'
import { startMockBackend } from './support/mockBackend'

const execFile = promisify(execFileCallback)

type ForkRpcCall = {
  method: string
  params?: Record<string, unknown>
}

type ConversationForkTurn = {
  id: string
  items: Array<{
    type: 'agentMessage'
    id: string
    text: string
    phase: 'final_answer'
    memoryCitation: null
  }>
  itemsView: 'full'
  status: 'completed'
  error: null
  startedAt: number
  completedAt: number
  durationMs: number
}

type ConversationForkThread = {
  id: string
  extra: null
  sessionId: string
  forkedFromId: string | null
  parentThreadId: null
  preview: string
  ephemeral: false
  section: null
  sectionEnteredAt: null
  historyMode: 'full'
  modelProvider: string
  createdAt: number
  updatedAt: number
  recencyAt: number
  status: { type: 'idle' }
  path: null
  cwd: string
  cliVersion: string
  source: 'app-server'
  canAcceptDirectInput: true
  threadSource: null
  agentNickname: null
  agentRole: null
  gitInfo: null
  name: string
  turns: ConversationForkTurn[]
}

type ConversationForkState = {
  threads: ConversationForkThread[]
}

test('forks from a historical assistant step without changing the source task', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const serverStateDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-conversation-fork-'))
  const statePath = join(serverStateDir, 'state.json')
  const rpcLogPath = join(serverStateDir, 'rpc.jsonl')
  await writeFile(statePath, JSON.stringify(initialState()), 'utf8')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/conversation-fork-app-server.mjs'),
        DASCOWORK_E2E_CONVERSATION_FORK_STATE_PATH: statePath,
        DASCOWORK_E2E_CONVERSATION_FORK_RPC_LOG_PATH: rpcLogPath
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await createLocalProject(page, 'Fork history project', appRoot)
    await expect
      .poll(() => page.evaluate(() => window.desktopApp.conversations.refreshConversationList()), {
        timeout: 15_000
      })
      .toMatchObject({ conversations: [expect.objectContaining({ id: 'source-thread' })] })

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await sidebar.getByRole('button', { name: 'Fork source task', exact: true }).click()
    const sourceAssistantMessages = page.locator('[data-role="assistant"]')
    await expect(sourceAssistantMessages.filter({ hasText: 'First retained answer' })).toBeVisible()
    await expect(
      sourceAssistantMessages.filter({ hasText: 'Later answer to discard' })
    ).toBeVisible()

    const firstAssistant = sourceAssistantMessages.filter({ hasText: 'First retained answer' })
    await firstAssistant.hover()
    const forkTrigger = firstAssistant.getByRole('button', { name: '从这里继续', exact: true })
    await expect(forkTrigger).toBeVisible()
    const opened = await page.evaluate(() =>
      window.desktopApp.conversations.forkConversation({
        conversationId: 'source-thread',
        targetTurnId: 'turn-1',
        mode: 'new-task'
      })
    )
    expect(opened.conversationId).toBe('forked-thread')
    expect(JSON.stringify(opened.messages)).toContain('First retained answer')
    expect(JSON.stringify(opened.messages)).not.toContain('Later answer to discard')

    await expect
      .poll(() => readForkRpcLog(rpcLogPath), { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining([
          {
            method: 'thread/fork',
            params: { threadId: 'source-thread', ephemeral: false }
          },
          {
            method: 'thread/rollback',
            params: { threadId: 'forked-thread', numTurns: 1 }
          }
        ])
      )

    const state = JSON.parse(await readFile(statePath, 'utf8')) as ConversationForkState
    expect(state.threads.find((thread) => thread.id === 'source-thread')?.turns).toHaveLength(2)
    expect(state.threads.find((thread) => thread.id === 'forked-thread')?.turns).toHaveLength(1)
  } finally {
    logs.push(
      `[conversation-fork-fixture] ${await readFile(rpcLogPath, 'utf8').catch((error) => String(error))}`
    )
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([serverStateDir])
  }
})

test('creates a fork in an isolated app-owned Git worktree', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const sourceRepository = await createGitRepository()
  const userDataDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-conversation-fork-user-data-'))
  const serverStateDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-conversation-fork-'))
  const statePath = join(serverStateDir, 'state.json')
  const rpcLogPath = join(serverStateDir, 'rpc.jsonl')
  await writeFile(statePath, JSON.stringify(initialState(sourceRepository)), 'utf8')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      userDataDir,
      preserveDataDirectories: true,
      environment: {
        CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/conversation-fork-app-server.mjs'),
        DASCOWORK_E2E_CONVERSATION_FORK_STATE_PATH: statePath,
        DASCOWORK_E2E_CONVERSATION_FORK_RPC_LOG_PATH: rpcLogPath
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    const opened = await page.evaluate(() =>
      window.desktopApp.conversations.forkConversation({
        conversationId: 'source-thread',
        targetTurnId: 'turn-1',
        mode: 'new-worktree'
      })
    )
    const assignment = opened.projectAssignment
    if (
      !assignment ||
      assignment.projectKind !== 'local' ||
      !assignment.managedWorktree ||
      !assignment.cwd
    ) {
      throw new Error('Forked task did not return an app-owned local worktree assignment.')
    }

    const metadata = assignment.managedWorktree
    expect(metadata.repositoryRoot).toBe(
      await gitOutput(sourceRepository, ['rev-parse', '--show-toplevel'])
    )
    expect(metadata.worktreePath).toBe(assignment.cwd)
    expect(metadata.worktreePath).toMatch(
      new RegExp(`^${escapeRegExp(join(await realpath(join(userDataDir, 'worktrees')), 'fork-'))}`)
    )
    expect((await stat(metadata.worktreePath)).isDirectory()).toBe(true)
    await expect(gitOutput(metadata.worktreePath, ['rev-parse', '--show-toplevel'])).resolves.toBe(
      await realpath(metadata.worktreePath)
    )
    await expect(gitOutput(metadata.worktreePath, ['branch', '--show-current'])).resolves.toBe(
      metadata.branch
    )
    expect(JSON.stringify(opened.messages)).toContain('First retained answer')
    expect(JSON.stringify(opened.messages)).not.toContain('Later answer to discard')

    await execFile('git', [
      '-C',
      metadata.repositoryRoot,
      'worktree',
      'remove',
      '--force',
      metadata.worktreePath
    ])
    await expect(stat(metadata.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })

    const recoveryInput = { conversationId: opened.conversationId, threadId: opened.conversationId }
    await expect(
      page.evaluate(
        (input) => window.desktopApp.projects.getWorkspaceRecovery(input),
        recoveryInput
      )
    ).resolves.toEqual({ state: 'restorable' })
    await expect(
      page.evaluate((input) => window.desktopApp.projects.restoreWorkspace(input), recoveryInput)
    ).resolves.toEqual({ state: 'available' })
    expect((await stat(metadata.worktreePath)).isDirectory()).toBe(true)
    await expect(gitOutput(metadata.worktreePath, ['rev-parse', '--show-toplevel'])).resolves.toBe(
      metadata.worktreePath
    )
    await expect(gitOutput(metadata.worktreePath, ['branch', '--show-current'])).resolves.toBe(
      metadata.branch
    )
    await expect(
      page.evaluate(
        (input) => window.desktopApp.projects.getWorkspaceRecovery(input),
        recoveryInput
      )
    ).resolves.toEqual({ state: 'available' })

    const state = JSON.parse(await readFile(statePath, 'utf8')) as ConversationForkState
    expect(state.threads.find((thread) => thread.id === 'source-thread')?.turns).toHaveLength(2)
    expect(state.threads.find((thread) => thread.id === 'forked-thread')?.turns).toHaveLength(1)
  } finally {
    logs.push(
      `[conversation-fork-fixture] ${await readFile(rpcLogPath, 'utf8').catch((error) => String(error))}`
    )
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([serverStateDir, userDataDir, sourceRepository])
  }
})

async function readForkRpcLog(path: string): Promise<ForkRpcCall[]> {
  const contents = await readFile(path, 'utf8').catch(() => '')
  return contents
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ForkRpcCall)
}

function initialState(cwd = appRoot): ConversationForkState {
  const now = Math.floor(Date.now() / 1000)
  return {
    threads: [
      {
        id: 'source-thread',
        extra: null,
        sessionId: 'source-thread',
        forkedFromId: null,
        parentThreadId: null,
        preview: 'Fork source task',
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        historyMode: 'full',
        modelProvider: 'e2e',
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
        status: { type: 'idle' },
        path: null,
        cwd,
        cliVersion: 'e2e',
        source: 'app-server',
        canAcceptDirectInput: true,
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: 'Fork source task',
        turns: [
          completedAssistantTurn('turn-1', 'First retained answer', now),
          completedAssistantTurn('turn-2', 'Later answer to discard', now + 1)
        ]
      }
    ]
  }
}

function completedAssistantTurn(id: string, text: string, startedAt: number): ConversationForkTurn {
  return {
    id,
    items: [
      {
        type: 'agentMessage',
        id: `item-${id}`,
        text,
        phase: 'final_answer',
        memoryCitation: null
      }
    ],
    itemsView: 'full',
    status: 'completed',
    error: null,
    startedAt,
    completedAt: startedAt,
    durationMs: 10
  }
}

async function createGitRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'dascowork-e2e-conversation-fork-repository-'))
  await execFile('git', ['init', '--quiet', repository])
  await writeFile(join(repository, 'README.md'), 'fork fixture\n', 'utf8')
  await execFile('git', ['-C', repository, 'add', 'README.md'])
  await execFile('git', [
    '-C',
    repository,
    '-c',
    'user.name=E2E Fixture',
    '-c',
    'user.email=e2e@example.test',
    'commit',
    '--quiet',
    '-m',
    'Initial fixture'
  ])
  return repository
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args])
  return stdout.trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
