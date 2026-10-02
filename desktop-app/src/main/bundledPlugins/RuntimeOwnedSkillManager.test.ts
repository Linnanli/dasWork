import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { RuntimeOwnedSkillManager } from './RuntimeOwnedSkillManager'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('RuntimeOwnedSkillManager', () => {
  it('moves manifest-declared legacy skills, then replaces only its owned skill namespace', async () => {
    const fixture = await createFixture()
    const legacyDirectory = join(fixture.codexHome, 'skills', 'legacy-presentation-skill')
    await mkdir(legacyDirectory, { recursive: true })
    await writeFile(join(legacyDirectory, 'SKILL.md'), '# Legacy')

    const result = await fixture
      .manager({ skillsToRemove: ['legacy-presentation-skill'] })
      .reconcile()

    expect(result).toEqual({
      copiedSkills: ['presentation-skill'],
      legacySkillsMoved: ['legacy-presentation-skill']
    })
    await expect(
      readFile(
        join(
          fixture.codexHome,
          'skills',
          'dascowork-primary-runtime',
          'presentation-skill',
          'SKILL.md'
        ),
        'utf8'
      )
    ).resolves.toBe(fixture.skill)
    await expect(readdir(legacyDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readdir(join(fixture.codexHome, '.tmp', 'legacy-primary-runtime-skills'))
    ).resolves.not.toHaveLength(0)
  })

  it('never replaces an unmarked user directory in the managed namespace', async () => {
    const fixture = await createFixture()
    const userDirectory = join(fixture.codexHome, 'skills', 'dascowork-primary-runtime')
    await mkdir(userDirectory, { recursive: true })
    await writeFile(join(userDirectory, 'SKILL.md'), '# User-owned')

    await expect(fixture.manager().reconcile()).rejects.toThrow(
      'refuses to replace an unowned Codex skills directory'
    )
    await expect(readFile(join(userDirectory, 'SKILL.md'), 'utf8')).resolves.toBe('# User-owned')
  })

  it('removes its owned managed namespace when the active Runtime declares no skills', async () => {
    const fixture = await createFixture()
    await fixture.manager().reconcile()

    await fixture.manager({ bundledSkills: [] }).reconcile()

    await expect(
      readdir(join(fixture.codexHome, 'skills', 'dascowork-primary-runtime'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('can roll back a replaced managed namespace after a later reload failure', async () => {
    const fixture = await createFixture()
    await fixture.manager().reconcile()
    const originalSkillPath = join(
      fixture.codexHome,
      'skills',
      'dascowork-primary-runtime',
      'presentation-skill',
      'SKILL.md'
    )
    await expect(readFile(originalSkillPath, 'utf8')).resolves.toBe(fixture.skill)

    const replacement = await createSkill(fixture.runtimeRoot, {
      directory: 'officecli',
      content: '# Runtime-owned OfficeCLI skill\n'
    })
    const transaction = await fixture
      .manager({ bundledSkills: [replacement] })
      .reconcileWithRollback()

    expect(transaction.result).toMatchObject({ copiedSkills: ['officecli'] })
    await expect(
      readFile(
        join(fixture.codexHome, 'skills', 'dascowork-primary-runtime', 'officecli', 'SKILL.md'),
        'utf8'
      )
    ).resolves.toBe('# Runtime-owned OfficeCLI skill\n')

    await transaction.rollback()

    await expect(readFile(originalSkillPath, 'utf8')).resolves.toBe(fixture.skill)
    await expect(
      readdir(join(fixture.codexHome, 'skills', 'dascowork-primary-runtime', 'officecli'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not move the current managed namespace through skillsToRemove', async () => {
    const fixture = await createFixture()
    await fixture.manager().reconcile()

    const replacement = await createSkill(fixture.runtimeRoot, {
      directory: 'officecli',
      content: '# Runtime-owned OfficeCLI skill\n'
    })
    const result = await fixture
      .manager({
        bundledSkills: [replacement],
        skillsToRemove: ['dascowork-primary-runtime/presentation-skill']
      })
      .reconcile()

    expect(result).toEqual({ copiedSkills: ['officecli'], legacySkillsMoved: [] })
    await expect(
      readFile(
        join(fixture.codexHome, 'skills', 'dascowork-primary-runtime', 'officecli', 'SKILL.md'),
        'utf8'
      )
    ).resolves.toBe('# Runtime-owned OfficeCLI skill\n')
  })

  it('does not remove an unmarked user namespace when the active Runtime declares no skills', async () => {
    const fixture = await createFixture()
    const userDirectory = join(fixture.codexHome, 'skills', 'dascowork-primary-runtime')
    await mkdir(userDirectory, { recursive: true })
    await writeFile(join(userDirectory, 'SKILL.md'), '# User-owned')

    await expect(fixture.manager({ bundledSkills: [] }).reconcile()).rejects.toThrow(
      'refuses to replace an unowned Codex skills directory'
    )
    await expect(readFile(join(userDirectory, 'SKILL.md'), 'utf8')).resolves.toBe('# User-owned')
  })

  it('rejects a legacy skill path that could leave the Codex skills root', async () => {
    const fixture = await createFixture()

    await expect(fixture.manager({ skillsToRemove: ['../outside'] }).reconcile()).rejects.toThrow(
      'must stay within the Codex skills directory'
    )
  })
})

async function createFixture(): Promise<{
  codexHome: string
  runtimeRoot: string
  skill: string
  manager(overrides?: {
    bundledSkills?: Array<{ path: string; sha256: string }>
    skillsToRemove?: string[]
  }): RuntimeOwnedSkillManager
}> {
  const root = await mkdtemp(join(tmpdir(), 'dascowork-runtime-owned-skills-'))
  directories.push(root)
  const codexHome = join(root, 'codex-home')
  const runtimeRoot = join(root, 'runtime')
  const skill = '# Runtime-owned presentation skill\n'
  await mkdir(join(codexHome, 'skills'), { recursive: true })
  const bundledSkill = await createSkill(runtimeRoot, {
    directory: 'presentation-skill',
    content: skill
  })
  return {
    codexHome,
    runtimeRoot,
    skill,
    manager: (overrides = {}) =>
      new RuntimeOwnedSkillManager({
        codexHome,
        runtimeRoot,
        bundleVersion: 'test-v1',
        manifest: {
          bundledSkills: overrides.bundledSkills ?? [bundledSkill],
          skillsToRemove: overrides.skillsToRemove ?? []
        }
      })
  }
}

async function createSkill(
  runtimeRoot: string,
  input: { directory: string; content: string }
): Promise<{ path: string; sha256: string }> {
  const relativeSkillPath = `plugins/${input.directory}/plugins/${input.directory}/skills/${input.directory}/SKILL.md`
  const skillPath = join(runtimeRoot, relativeSkillPath)
  await mkdir(join(skillPath, '..'), { recursive: true })
  await writeFile(skillPath, input.content)
  return {
    path: relativeSkillPath,
    sha256: createHash('sha256').update(input.content).digest('hex')
  }
}
