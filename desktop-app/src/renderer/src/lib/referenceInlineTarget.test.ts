import { describe, expect, it } from 'vitest'

import {
  classifyReferenceTarget,
  parseLocalReferenceTarget,
  referenceUrlTransform
} from './referenceInlineTarget'

describe('classifyReferenceTarget', () => {
  it.each([
    ['app', { href: 'app://github', label: 'GitHub' }, 'app'],
    ['plugin', { href: 'plugin://github@official', label: 'GitHub' }, 'plugin'],
    ['live agent', { href: 'agent://thread-child', label: 'Explorer' }, 'agent'],
    ['configured agent', { href: 'subagent://reviewer', label: 'Reviewer' }, 'agent'],
    ['thread conversation', { href: 'thread://thread-child', label: 'Prior task' }, 'conversation'],
    [
      'ChatGPT conversation',
      { href: 'chatgpt-conversation://conversation%20one', label: 'Prior task' },
      'conversation'
    ],
    [
      'MCP resource',
      { href: 'mcp-resource://docs/app%3A%2F%2Fdocs%2F1', label: 'Docs' },
      'mcp-resource'
    ],
    ['Sites project', { href: 'sites-project://project%201', label: 'Site' }, 'sites-project'],
    ['skill label', { href: '/repo/skills/review/SKILL.md', label: '$review' }, 'skill'],
    ['HTTP fallback', { href: 'https://example.test/docs', label: 'Docs' }, 'external-url'],
    ['POSIX file', { href: '/repo/src/app.ts:12', label: 'app.ts' }, 'local-file'],
    ['Windows file', { href: 'C:\\repo\\src\\app.ts:8', label: 'app.ts' }, 'local-file'],
    ['directory', { href: 'src/components/', label: 'components' }, 'local-folder']
  ])('%s follows the reference semantic branch', (_name, input, kind) => {
    expect(classifyReferenceTarget(input)?.kind).toBe(kind)
  })

  it('parses local paths and line numbers without treating traversal as a file reference', () => {
    expect(parseLocalReferenceTarget('file:///tmp/project/readme.md:3')).toMatchObject({
      kind: 'local-file',
      path: '/tmp/project/readme.md',
      line: 3
    })
    expect(parseLocalReferenceTarget('C:\\repo\\src\\app.ts:8')).toMatchObject({
      kind: 'local-file',
      path: 'C:\\repo\\src\\app.ts',
      line: 8
    })
    expect(parseLocalReferenceTarget('./src/App.tsx:4')).toMatchObject({
      kind: 'local-file',
      path: './src/App.tsx',
      line: 4
    })
    expect(parseLocalReferenceTarget('../secret.txt')).toBeUndefined()
    expect(parseLocalReferenceTarget('src/%2e%2e/secret.txt')).toBeUndefined()
    expect(parseLocalReferenceTarget('file://server/share.txt')).toBeUndefined()
  })

  it.each(['javascript:alert(1)', 'data:text/html,hello', 'unknown://target', 'src/%ZZ'])(
    'marks unsafe or unknown custom links as unsupported: %s',
    (href) => {
      expect(classifyReferenceTarget({ href, label: 'unsafe' })?.kind).toBe('unsupported')
      expect(referenceUrlTransform(href)).toBeNull()
    }
  )

  it('preserves the semantic URLs only for the Markdown component to consume', () => {
    expect(referenceUrlTransform('app://github')).toBe('app://github')
    expect(referenceUrlTransform('mcp-resource://docs/app%3A%2F%2Fdocs')).toBe(
      'mcp-resource://docs/app%3A%2F%2Fdocs'
    )
    expect(referenceUrlTransform('https://example.test')).toBe('https://example.test')
    expect(referenceUrlTransform('#heading')).toBe('#heading')
  })
})
