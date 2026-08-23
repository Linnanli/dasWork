import { describe, expect, it } from 'vitest'

import {
  resolveInlineReferenceAction,
  workspaceRelativePath,
  type InlineReferenceAction
} from './referenceInlineAction'
import { classifyReferenceTarget } from './referenceInlineTarget'

const localWorkspace = {
  canOpenLocalPaths: true,
  canOpenWorkspace: true,
  workspaceCwd: '/repo'
}

describe('resolveInlineReferenceAction', () => {
  it('routes HTTP and HTTPS to the controlled workspace browser', () => {
    expect(actionFor('https://example.test/docs')).toEqual({
      type: 'workspace-browser',
      url: 'https://example.test/docs'
    })
    expect(actionFor('http://example.test/docs')).toEqual({
      type: 'workspace-browser',
      url: 'http://example.test/docs'
    })
  })

  it('opens workspace-contained paths and carries location without changing the tab identity', () => {
    expect(actionFor('/repo/src/App.tsx:42:3-45')).toEqual({
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 42,
      column: 3,
      endLine: 45,
      mode: 'preview'
    })
    expect(actionFor('./src/App.tsx:42')).toEqual({
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 42,
      mode: 'preview'
    })
    expect(actionFor('src/./App.tsx:42')).toEqual({
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 42,
      mode: 'preview'
    })
    expect(actionFor('/repo/src/./App.tsx:42')).toEqual({
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 42,
      mode: 'preview'
    })
    expect(actionFor('src/components/')).toEqual({
      type: 'workspace-folder',
      relativePath: 'src/components'
    })
    expect(actionFor('/repo/src/foo%2520bar.ts')).toEqual({
      type: 'workspace-file',
      relativePath: 'src/foo%20bar.ts',
      mode: 'preview'
    })
  })

  it('keeps cwd containment and safely falls back for paths outside it', () => {
    expect(workspaceRelativePath('/repo/src/App.tsx', '/repo')).toBe('src/App.tsx')
    expect(workspaceRelativePath('src/./App.tsx', '/repo')).toBe('src/App.tsx')
    expect(workspaceRelativePath('/repo/src/./App.tsx', '/repo')).toBe('src/App.tsx')
    expect(workspaceRelativePath('src/../secret.txt', '/repo')).toBeUndefined()
    expect(workspaceRelativePath('/repo/src/../secret.txt', '/repo')).toBeUndefined()
    expect(workspaceRelativePath('/repo-other/src/App.tsx', '/repo')).toBeUndefined()
    expect(workspaceRelativePath('C:\\Repo\\src\\App.tsx', 'c:\\repo')).toBe('src/App.tsx')
    expect(actionFor('/tmp/secret.txt')).toEqual({ type: 'system-file', path: '/tmp/secret.txt' })
    expect(
      resolveInlineReferenceAction(
        classifyReferenceTarget({ href: '../secret.txt' })!,
        localWorkspace
      )
    ).toEqual({ type: 'display-only', reason: 'unsupported' })
  })

  it('uses only explicit capability fallbacks and never promotes unsafe schemes to browser actions', () => {
    const noWorkspace = { ...localWorkspace, canOpenWorkspace: false }
    const httpReference = classifyReferenceTarget({ href: 'https://example.test/docs' })
    const localReference = classifyReferenceTarget({ href: 'src/App.tsx:2' })

    expect(httpReference).toBeDefined()
    expect(localReference).toBeDefined()
    expect(resolveInlineReferenceAction(httpReference!, noWorkspace)).toEqual({
      type: 'external-browser',
      url: 'https://example.test/docs'
    })
    expect(resolveInlineReferenceAction(localReference!, noWorkspace)).toEqual({
      type: 'system-file',
      path: 'src/App.tsx',
      cwd: '/repo',
      line: 2
    })

    for (const href of ['javascript:alert(1)', 'data:text/plain,blocked', 'unknown://target']) {
      expect(actionFor(href)).toEqual({ type: 'display-only', reason: 'unsupported' })
    }
  })

  it('only resolves catalog-backed live agents and skills', () => {
    const semanticTargets = {
      agentThreads: new Map([['agent://child', 'thread-child']]),
      skillPaths: new Map([['$review', '/repo/.codex/skills/review/SKILL.md']])
    }
    expect(
      resolveInlineReferenceAction(classifyReferenceTarget({ href: 'agent://child' })!, {
        ...localWorkspace,
        semanticTargets
      })
    ).toEqual({ type: 'conversation', conversationId: 'thread-child' })
    expect(
      resolveInlineReferenceAction(classifyReferenceTarget({ inlineText: '$review' })!, {
        ...localWorkspace,
        semanticTargets
      })
    ).toEqual({
      type: 'workspace-file',
      relativePath: '.codex/skills/review/SKILL.md',
      mode: 'preview'
    })
    expect(actionFor('subagent://reviewer')).toEqual({
      type: 'display-only',
      reason: 'missing-live-agent-target'
    })
    expect(actionFor('plugin://example')).toEqual({
      type: 'display-only',
      reason: 'no-internal-route'
    })
  })
})

function actionFor(href: string): InlineReferenceAction {
  const descriptor = classifyReferenceTarget({ href })
  if (!descriptor) throw new Error(`Expected ${href} to classify.`)
  return resolveInlineReferenceAction(descriptor, localWorkspace)
}
