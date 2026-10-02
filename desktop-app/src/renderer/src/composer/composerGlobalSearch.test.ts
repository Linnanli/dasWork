import { describe, expect, it } from 'vitest'

import type { ComposerContextReference } from '../../../shared/codexIpcApi'
import { composerContextReferenceToTriggerItem } from './useComposerContextCatalog'
import { buildComposerGlobalSearchResult } from './composerGlobalSearch'

function item(
  reference: ComposerContextReference
): ReturnType<typeof composerContextReferenceToTriggerItem> {
  return composerContextReferenceToTriggerItem(reference)
}

describe('buildComposerGlobalSearchResult', () => {
  it('uses one global top-8 window and keeps prefix plugins ahead of static and dynamic items', () => {
    const plugin = item({
      version: 1,
      kind: 'plugin',
      canonicalId: 'plugin:needle-plugin',
      label: 'Needle Plugin',
      presentation: 'mention',
      pluginId: 'needle-plugin',
      uri: 'plugin://needle-plugin',
      mentionName: 'needle-plugin'
    })
    const agents = Array.from({ length: 7 }, (_, index) =>
      item({
        version: 1,
        kind: 'configuredAgent',
        canonicalId: `configured-agent:needle-${index}`,
        label: `needle agent ${index}`,
        presentation: 'mention',
        roleName: `needle-${index}`,
        uri: `subagent://needle-${index}`
      })
    )
    const file = item({
      version: 1,
      kind: 'file',
      canonicalId: 'file:/repo/needle.ts',
      label: 'needle.ts',
      presentation: 'mention',
      path: '/repo/needle.ts',
      root: '/repo'
    })
    const task = item({
      version: 1,
      kind: 'chat',
      canonicalId: 'chat:needle-task',
      label: 'needle task',
      presentation: 'mention',
      threadId: 'needle-task',
      uri: 'thread://needle-task',
      snippet: 'needle history'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'needle',
      loading: false,
      sourceErrors: [],
      sections: [
        { id: 'plugins', items: [plugin] },
        { id: 'agents', items: agents },
        { id: 'files', items: [file] },
        { id: 'tasks', items: [task] }
      ]
    })

    expect(section?.showTitle).toBe(false)
    expect(section?.items).toHaveLength(8)
    expect(section?.items[0]).toBe(plugin)
    expect(section?.items).not.toContain(task)
  })

  it('does not search app descriptions while configured agent descriptions remain searchable', () => {
    const app = item({
      version: 1,
      kind: 'app',
      canonicalId: 'app:calendar',
      label: 'Calendar',
      description: 'secret-description-needle',
      presentation: 'mention',
      appId: 'calendar',
      uri: 'app://calendar',
      mentionName: 'calendar'
    })
    const agent = item({
      version: 1,
      kind: 'configuredAgent',
      canonicalId: 'configured-agent:reviewer',
      label: 'reviewer',
      description: 'secret-description-needle',
      presentation: 'mention',
      roleName: 'reviewer',
      uri: 'subagent://reviewer'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'secret-description-needle',
      loading: false,
      sourceErrors: [],
      sections: [
        { id: 'apps', items: [app] },
        { id: 'agents', items: [agent] }
      ]
    })

    expect(section?.items).toEqual([agent])
  })

  it('matches the reference project for readme results across static and file sources', () => {
    const plugin = item({
      version: 1,
      kind: 'plugin',
      canonicalId: 'plugin:spreadsheets@presentation-skill',
      label: 'Spreadsheets',
      description: 'Create and edit spreadsheet files',
      presentation: 'mention',
      pluginId: 'spreadsheets@presentation-skill',
      uri: 'plugin://spreadsheets@presentation-skill',
      mentionName: 'spreadsheets'
    })
    const skill = item({
      version: 1,
      kind: 'skill',
      canonicalId: 'skill:/skills/artifact-template-simple-dark-mode/SKILL.md',
      label: 'openai-templates:artifact-template-simple-dark-mode',
      description: 'Create a presentation using the Simple Dark Mode template',
      presentation: 'mention',
      name: 'openai-templates:artifact-template-simple-dark-mode',
      path: '/skills/artifact-template-simple-dark-mode/SKILL.md'
    })
    const agents = [
      item({
        version: 1,
        kind: 'configuredAgent',
        canonicalId: 'configured-agent:prometheus-strict-metis',
        label: 'prometheus-strict-metis',
        description: 'Prometheus Strict requirements interviewer and ambiguity mapper',
        presentation: 'mention',
        roleName: 'prometheus-strict-metis',
        uri: 'subagent://prometheus-strict-metis'
      }),
      item({
        version: 1,
        kind: 'configuredAgent',
        canonicalId: 'configured-agent:scholastic',
        label: 'scholastic',
        description:
          'Ontology-first reasoning reviewer: category mistakes, hidden assumptions, modality separation, scholastic critique, and minimal-repair proposals',
        presentation: 'mention',
        roleName: 'scholastic',
        uri: 'subagent://scholastic'
      })
    ]
    const readme = item({
      version: 1,
      kind: 'file',
      canonicalId: 'file:/repo/README.md',
      label: 'README.md',
      presentation: 'mention',
      path: '/repo/README.md',
      root: '/repo'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'readme',
      loading: false,
      sourceErrors: [],
      sections: [
        { id: 'plugins', items: [plugin] },
        { id: 'skills', items: [skill] },
        { id: 'agents', items: agents },
        { id: 'files', items: [readme] }
      ]
    })

    expect(section?.items).toEqual([readme])
  })

  it('does not search plugin ids or app connector ids', () => {
    const plugin = item({
      version: 1,
      kind: 'plugin',
      canonicalId: 'plugin:readme-plugin@marketplace',
      label: 'Spreadsheets',
      presentation: 'mention',
      pluginId: 'readme-plugin@marketplace',
      uri: 'plugin://readme-plugin@marketplace',
      mentionName: 'spreadsheets'
    })
    const app = item({
      version: 1,
      kind: 'app',
      canonicalId: 'app:readme-connector-id',
      label: 'Calendar',
      presentation: 'mention',
      appId: 'readme-connector-id',
      uri: 'app://readme-connector-id',
      mentionName: 'calendar'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'readme',
      loading: false,
      sourceErrors: [],
      sections: [
        { id: 'plugins', items: [plugin] },
        { id: 'apps', items: [app] }
      ]
    })

    expect(section?.items).toEqual([])
  })

  it('searches app plugin display names like the reference project', () => {
    const app = item({
      version: 1,
      kind: 'app',
      canonicalId: 'app:calendar',
      label: 'Calendar',
      presentation: 'mention',
      appId: 'calendar',
      uri: 'app://calendar',
      mentionName: 'calendar',
      pluginDisplayNames: ['Productivity Suite']
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'productivity',
      loading: false,
      sourceErrors: [],
      sections: [{ id: 'apps', items: [app] }]
    })

    expect(section?.items).toEqual([app])
  })

  it('keeps warnings visible when other search results are available', () => {
    const agent = item({
      version: 1,
      kind: 'configuredAgent',
      canonicalId: 'configured-agent:needle',
      label: 'needle',
      presentation: 'mention',
      roleName: 'needle',
      uri: 'subagent://needle'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'needle',
      loading: false,
      sourceErrors: [],
      warnings: ['每条消息最多引用 3 个任务'],
      sections: [{ id: 'agents', items: [agent] }]
    })

    expect(section?.items).toEqual([agent])
    expect(section?.error).toBe('每条消息最多引用 3 个任务')
  })

  it('hides source failures when usable results are available', () => {
    const agent = item({
      version: 1,
      kind: 'configuredAgent',
      canonicalId: 'configured-agent:needle',
      label: 'needle',
      presentation: 'mention',
      roleName: 'needle',
      uri: 'subagent://needle'
    })

    const [section] = buildComposerGlobalSearchResult({
      query: 'needle',
      loading: false,
      sourceErrors: ['文件搜索暂时不可用'],
      sections: [{ id: 'agents', items: [agent] }]
    })

    expect(section?.items).toEqual([agent])
    expect(section?.error).toBeUndefined()
  })

  it('waits for loading to finish before showing source failures', () => {
    const [section] = buildComposerGlobalSearchResult({
      query: 'needle',
      loading: true,
      sourceErrors: ['文件搜索暂时不可用'],
      sections: []
    })

    expect(section?.loading).toBe(true)
    expect(section?.error).toBeUndefined()
  })

  it('shows source failures only when search finishes without results', () => {
    const [section] = buildComposerGlobalSearchResult({
      query: 'needle',
      loading: false,
      sourceErrors: ['文件搜索暂时不可用'],
      sections: []
    })

    expect(section?.items).toEqual([])
    expect(section?.error).toBe('文件搜索暂时不可用')
  })
})
