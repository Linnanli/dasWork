import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, type Mock, vi } from 'vitest'

import { RecommendedSkillsService } from './RecommendedSkillsService'

const fixedNow = new Date('2026-08-30T00:00:00.000Z')
const oldCacheTime = '2026-08-30T00:00:00.000Z'

type TestGitRunner = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number }
) => Promise<{ stdout: string; stderr: string }>

async function makeCodexHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dascowork-recommended-skills-'))
}

async function writeCuratedSkill(
  codexHome: string,
  directoryName = 'writer',
  options: {
    root?: '.curated' | '.experimental'
    description?: string
    displayName?: string
    shortDescription?: string
    withSymlink?: boolean
  } = {}
): Promise<string> {
  const description = options.description ?? 'Write useful documents'
  const displayName = options.displayName ?? 'Writing assistant'
  const shortDescription = options.shortDescription ?? 'Write clear docs'
  const skillDirectory = join(
    codexHome,
    'vendor_imports',
    'skills',
    'skills',
    options.root ?? '.curated',
    directoryName
  )
  await mkdir(join(skillDirectory, 'agents'), { recursive: true })
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    [
      '---',
      `name: ${directoryName}`,
      `description: ${description}`,
      '---',
      '',
      `# ${displayName}`
    ].join('\n')
  )
  await writeFile(
    join(skillDirectory, 'agents', 'openai.yaml'),
    [
      'interface:',
      `  display_name: ${displayName}`,
      `  short_description: ${shortDescription}`
    ].join('\n')
  )
  if (options.withSymlink) {
    await symlink(join(skillDirectory, 'SKILL.md'), join(skillDirectory, 'linked-skill.md'))
  }
  return skillDirectory
}

function controlledGit(): Mock<TestGitRunner> {
  return vi.fn<TestGitRunner>(async (_cwd, args) => {
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') {
      return { stdout: 'true\n', stderr: '' }
    }
    if (args.join(' ') === 'remote get-url origin') {
      return { stdout: 'https://github.com/openai/skills.git\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

describe('RecommendedSkillsService', () => {
  it('returns every skill from a fresh local cache without calling git', async () => {
    const codexHome = await makeCodexHome()
    const git = controlledGit()
    try {
      await mkdir(join(codexHome, 'vendor_imports'), { recursive: true })
      await writeFile(
        join(codexHome, 'vendor_imports', 'skills-curated-cache.json'),
        JSON.stringify({
          fetchedAt: oldCacheTime,
          skills: [
            {
              id: 'playwright',
              name: 'Playwright',
              description: 'Automate real browsers',
              repoPath: 'skills/.curated/playwright'
            },
            {
              id: 'writer',
              name: 'Writer',
              description: 'Write useful documents',
              repoPath: 'skills/.curated/writer'
            }
          ]
        })
      )
      const service = new RecommendedSkillsService({ codexHome, now: () => fixedNow, runGit: git })

      const result = await service.getRecommendedSkills()

      expect(result.source).toBe('cache')
      expect(result.skills).toEqual([
        expect.objectContaining({ id: 'playwright', name: 'Playwright' }),
        expect.objectContaining({ id: 'writer', name: 'Writer' })
      ])
      expect(git).not.toHaveBeenCalled()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('refreshes the controlled checkout, parses curated metadata, and persists the cache', async () => {
    const codexHome = await makeCodexHome()
    const git = controlledGit()
    try {
      await Promise.all([
        writeCuratedSkill(codexHome),
        writeCuratedSkill(codexHome, 'playwright', {
          root: '.experimental',
          description: 'Automate real browsers',
          displayName: 'Playwright',
          shortDescription: 'Automate real browsers'
        })
      ])
      const service = new RecommendedSkillsService({
        codexHome,
        now: () => fixedNow,
        runGit: git,
        toMediaUrl: (path) => `app://fs/@fs${path}`
      })

      const result = await service.getRecommendedSkills()

      expect(result).toMatchObject({
        source: 'git',
        fetchedAt: fixedNow.toISOString(),
        skills: [
          {
            id: 'playwright',
            name: 'Playwright',
            description: 'Automate real browsers',
            shortDescription: 'Automate real browsers',
            repoPath: 'skills/.experimental/playwright'
          },
          {
            id: 'writer',
            name: 'Writing assistant',
            description: 'Write useful documents',
            shortDescription: 'Write clear docs',
            repoPath: 'skills/.curated/writer'
          }
        ]
      })
      expect(result.skills).toHaveLength(2)
      expect(git.mock.calls.map(([, args]) => args.join(' '))).toEqual(
        expect.arrayContaining([
          'rev-parse --is-inside-work-tree',
          'remote get-url origin',
          'fetch --depth=1 origin main',
          'reset --hard FETCH_HEAD',
          'sparse-checkout set --no-cone skills/.curated skills/.experimental'
        ])
      )
      expect(
        JSON.parse(
          await readFile(join(codexHome, 'vendor_imports', 'skills-curated-cache.json'), 'utf8')
        )
      ).toMatchObject({ skills: [{ id: 'playwright' }, { id: 'writer' }] })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('falls back to a stale cache when refresh fails without exposing git output', async () => {
    const codexHome = await makeCodexHome()
    try {
      await mkdir(join(codexHome, 'vendor_imports'), { recursive: true })
      await writeFile(
        join(codexHome, 'vendor_imports', 'skills-curated-cache.json'),
        JSON.stringify({
          fetchedAt: '2026-08-29T00:00:00.000Z',
          skills: [
            {
              id: 'playwright',
              name: 'Playwright',
              description: 'Automate real browsers',
              repoPath: 'skills/.curated/playwright'
            },
            {
              id: 'writer',
              name: 'Writer',
              description: 'Write useful documents',
              repoPath: 'skills/.curated/writer'
            }
          ]
        })
      )
      const service = new RecommendedSkillsService({
        codexHome,
        now: () => fixedNow,
        runGit: vi.fn(async () => {
          throw new Error('secret remote output')
        })
      })

      await expect(service.getRecommendedSkills()).resolves.toMatchObject({
        source: 'cache',
        skills: [{ id: 'playwright' }, { id: 'writer' }],
        error: '推荐技能目录暂时不可用，正在显示最近一次成功加载的内容。'
      })
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('installs only a catalog skill into CODEX_HOME/skills without overwriting an existing skill', async () => {
    const codexHome = await makeCodexHome()
    try {
      await writeCuratedSkill(codexHome)
      await mkdir(join(codexHome, 'vendor_imports'), { recursive: true })
      await writeFile(
        join(codexHome, 'vendor_imports', 'skills-curated-cache.json'),
        JSON.stringify({
          fetchedAt: oldCacheTime,
          skills: [
            {
              id: 'writer',
              name: 'Writer',
              description: 'Write useful documents',
              repoPath: 'skills/.curated/writer'
            }
          ]
        })
      )
      const service = new RecommendedSkillsService({ codexHome, now: () => fixedNow })

      await expect(
        service.installRecommendedSkill({ id: 'writer', repoPath: 'skills/.curated/writer' })
      ).resolves.toBe('installed')
      await expect(
        readFile(join(codexHome, 'skills', 'writer', 'SKILL.md'), 'utf8')
      ).resolves.toContain('# Writing assistant')
      await expect(
        service.installRecommendedSkill({ id: 'writer', repoPath: 'skills/.curated/writer' })
      ).resolves.toBe('already-installed')
      await expect(
        service.installRecommendedSkill({ id: 'writer', repoPath: '../outside' })
      ).rejects.toThrow('no longer available')
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('cleans up a temporary installation after rejecting a symlinked source file', async () => {
    const codexHome = await makeCodexHome()
    try {
      await writeCuratedSkill(codexHome, 'writer', { withSymlink: true })
      await mkdir(join(codexHome, 'vendor_imports'), { recursive: true })
      await writeFile(
        join(codexHome, 'vendor_imports', 'skills-curated-cache.json'),
        JSON.stringify({
          fetchedAt: oldCacheTime,
          skills: [
            {
              id: 'writer',
              name: 'Writer',
              description: 'Write useful documents',
              repoPath: 'skills/.curated/writer'
            }
          ]
        })
      )
      const service = new RecommendedSkillsService({ codexHome, now: () => fixedNow })

      await expect(
        service.installRecommendedSkill({ id: 'writer', repoPath: 'skills/.curated/writer' })
      ).rejects.toThrow('symbolic link')
      await expect(
        readFile(join(codexHome, 'skills', 'writer', 'SKILL.md'), 'utf8')
      ).rejects.toThrow()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })
})
