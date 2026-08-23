import { describe, expect, it } from 'vitest'

import {
  buildComposerContextIdentityIndex,
  inlineReferenceSemanticTargetsFromIdentityIndex
} from './composerContextIdentity'

describe('composerContextIdentity', () => {
  it('indexes display and canonical names by URI without deriving missing names from the URI', () => {
    const index = buildComposerContextIdentityIndex([
      {
        id: 'apps',
        items: [
          {
            id: 'app://app_123',
            type: 'app',
            label: 'Slack Workspace',
            metadata: { mentionName: 'slack' }
          },
          { id: 'app://unknown-slug', type: 'app', label: 'Legacy App' }
        ]
      }
    ])

    expect(index.get('app://app_123')).toEqual({
      type: 'app',
      uri: 'app://app_123',
      displayLabel: 'Slack Workspace',
      mentionName: 'slack'
    })
    expect(index.get('app://unknown-slug')).toEqual({
      type: 'app',
      uri: 'app://unknown-slug',
      displayLabel: 'Legacy App'
    })
  })

  it('keeps the real live-agent thread and skill path for inline resolution', () => {
    const index = buildComposerContextIdentityIndex([
      {
        id: 'agents',
        items: [
          {
            id: 'agent://child-agent',
            type: 'agent',
            label: 'Explorer',
            metadata: {
              reference: {
                kind: 'liveAgent',
                uri: 'agent://child-agent',
                threadId: 'thread-child',
                parentThreadId: 'thread-parent'
              }
            }
          }
        ]
      },
      {
        id: 'skills',
        items: [
          {
            id: '/repo/.codex/skills/review/SKILL.md',
            type: 'skill',
            label: 'review',
            metadata: {
              reference: {
                kind: 'skill',
                canonicalId: 'review',
                name: 'review',
                path: '/repo/.codex/skills/review/SKILL.md'
              }
            }
          }
        ]
      }
    ])

    expect(
      inlineReferenceSemanticTargetsFromIdentityIndex(index).agentThreads?.get(
        'agent://child-agent'
      )
    ).toBe('thread-child')
    expect(inlineReferenceSemanticTargetsFromIdentityIndex(index).skillPaths?.get('$review')).toBe(
      '/repo/.codex/skills/review/SKILL.md'
    )
  })
})
