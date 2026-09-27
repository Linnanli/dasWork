import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { PrimaryRuntimeManifest } from '../primaryRuntime'

const MANAGED_SKILLS_DIRECTORY = 'dascowork-primary-runtime'
const OWNER_MARKER = '.dascowork-primary-runtime.json'

type RuntimeSkillSource = {
  path: string
  sha256: string
}

export type RuntimeOwnedSkillReconcileResult = {
  copiedSkills: string[]
  legacySkillsMoved: string[]
}

export type RuntimeOwnedSkillReconcileTransaction = {
  result: RuntimeOwnedSkillReconcileResult
  rollback(): Promise<void>
}

type LegacySkillMove = {
  requestedPath: string
  target: string
  backup: string
}

/**
 * Materializes only manifest-declared Runtime skills below a dedicated Codex
 * skills namespace. The namespace marker prevents an install from replacing a
 * user-owned directory that happens to use the same name.
 */
export class RuntimeOwnedSkillManager {
  constructor(
    private readonly input: {
      codexHome: string
      runtimeRoot: string
      bundleVersion: string
      manifest: Pick<PrimaryRuntimeManifest, 'bundledSkills' | 'skillsToRemove'>
    }
  ) {}

  async reconcile(): Promise<RuntimeOwnedSkillReconcileResult> {
    const transaction = await this.reconcileWithRollback()
    return transaction.result
  }

  async reconcileWithRollback(): Promise<RuntimeOwnedSkillReconcileTransaction> {
    const skillsRoot = await this.skillsRoot()
    const skills = await this.resolveSources()
    const legacySkillMoves = await this.moveLegacySkills(skillsRoot)
    let rollbackManagedSkills: (() => Promise<void>) | undefined
    if (skills.length === 0) {
      rollbackManagedSkills = await this.removeManagedSkills(skillsRoot)
      return {
        result: {
          copiedSkills: [],
          legacySkillsMoved: legacySkillMoves.map((move) => move.requestedPath)
        },
        rollback: async () => {
          await rollbackManagedSkills?.()
          await restoreLegacySkills(legacySkillMoves)
        }
      }
    }

    rollbackManagedSkills = await this.replaceManagedSkills(skillsRoot, skills)
    return {
      result: {
        copiedSkills: skills.map((skill) => basename(dirname(skill.path))).sort(),
        legacySkillsMoved: legacySkillMoves.map((move) => move.requestedPath)
      },
      rollback: async () => {
        await rollbackManagedSkills?.()
        await restoreLegacySkills(legacySkillMoves)
      }
    }
  }

  private async skillsRoot(): Promise<string> {
    const root = join(this.input.codexHome, 'skills')
    await mkdir(root, { recursive: true })
    return realpath(root)
  }

  private async moveLegacySkills(skillsRoot: string): Promise<LegacySkillMove[]> {
    const moved: LegacySkillMove[] = []
    for (const requestedPath of this.input.manifest.skillsToRemove ?? []) {
      const target = pathInside(skillsRoot, requestedPath, 'legacy skill')
      const managedDistance = relative(
        pathInside(skillsRoot, MANAGED_SKILLS_DIRECTORY, 'managed skills'),
        target
      )
      if (
        managedDistance === '' ||
        (!managedDistance.startsWith('..') && !isAbsolute(managedDistance))
      ) {
        continue
      }
      const details = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (!details) continue
      if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(`Primary Runtime legacy skill is not a regular directory: ${requestedPath}`)
      }

      const backupRoot = join(this.input.codexHome, '.tmp', 'legacy-primary-runtime-skills')
      await mkdir(backupRoot, { recursive: true })
      const backup = join(backupRoot, `${basename(target)}-${Date.now()}-${randomUUID()}`)
      await rename(target, backup)
      moved.push({ requestedPath, target, backup })
    }
    return moved
  }

  private async resolveSources(): Promise<RuntimeSkillSource[]> {
    const root = await realpath(this.input.runtimeRoot)
    const byDirectory = new Set<string>()
    const sources: RuntimeSkillSource[] = []

    for (const skill of this.input.manifest.bundledSkills ?? []) {
      const requestedPath = pathInside(root, skill.path, 'bundled skill')
      const source = await realpath(requestedPath).catch(() => {
        throw new Error(`Primary Runtime bundled skill is missing: ${skill.path}`)
      })
      if (!isPathInside(root, source) || basename(source) !== 'SKILL.md') {
        throw new Error(`Primary Runtime bundled skill escapes its Runtime: ${skill.path}`)
      }
      const details = await lstat(source)
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error(`Primary Runtime bundled skill is not a regular file: ${skill.path}`)
      }
      const digest = createHash('sha256')
        .update(await readFile(source))
        .digest('hex')
      if (digest !== skill.sha256) {
        throw new Error(`Primary Runtime bundled skill digest does not match: ${skill.path}`)
      }

      const sourceDirectory = dirname(source)
      const directoryName = basename(sourceDirectory)
      if (!safeDirectoryName(directoryName) || byDirectory.has(directoryName)) {
        throw new Error(`Primary Runtime bundled skill directory is ambiguous: ${skill.path}`)
      }
      await assertRegularTree(sourceDirectory)
      byDirectory.add(directoryName)
      sources.push({ path: source, sha256: digest })
    }
    return sources
  }

  private async removeManagedSkills(skillsRoot: string): Promise<() => Promise<void>> {
    const managedRoot = pathInside(skillsRoot, MANAGED_SKILLS_DIRECTORY, 'managed skills')
    const managedRootDetails = await lstat(managedRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!managedRootDetails) return async () => undefined

    await assertManagedRoot(managedRoot)
    const backupRoot = join(this.input.codexHome, '.tmp', 'primary-runtime-skills')
    await mkdir(backupRoot, { recursive: true })
    const backup = join(backupRoot, `previous-${randomUUID()}`)
    await rename(managedRoot, backup)
    return async () => {
      await rm(managedRoot, { recursive: true, force: true }).catch(() => undefined)
      await rename(backup, managedRoot)
    }
  }

  private async replaceManagedSkills(
    skillsRoot: string,
    skills: readonly RuntimeSkillSource[]
  ): Promise<() => Promise<void>> {
    const managedRoot = pathInside(skillsRoot, MANAGED_SKILLS_DIRECTORY, 'managed skills')
    const managedRootDetails = await lstat(managedRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (managedRootDetails) await assertManagedRoot(managedRoot)

    const stagingParent = join(this.input.codexHome, '.tmp', 'primary-runtime-skills')
    const stagingRoot = join(stagingParent, randomUUID())
    await mkdir(stagingRoot, { recursive: true })
    try {
      for (const skill of skills) {
        await cp(dirname(skill.path), join(stagingRoot, basename(dirname(skill.path))), {
          recursive: true,
          force: false,
          errorOnExist: true
        })
      }
      await writeFile(
        join(stagingRoot, OWNER_MARKER),
        `${JSON.stringify(
          {
            owner: MANAGED_SKILLS_DIRECTORY,
            bundleVersion: this.input.bundleVersion,
            skills: skills.map((skill) => ({
              name: basename(dirname(skill.path)),
              sha256: skill.sha256
            }))
          },
          null,
          2
        )}\n`
      )

      let backup: string | undefined
      if (managedRootDetails) {
        backup = join(stagingParent, `previous-${randomUUID()}`)
        await rename(managedRoot, backup)
      }
      try {
        await rename(stagingRoot, managedRoot)
      } catch (error) {
        if (backup) await rename(backup, managedRoot).catch(() => undefined)
        throw error
      }
      return async () => {
        const failedRoot = join(stagingParent, `failed-${randomUUID()}`)
        await rename(managedRoot, failedRoot).catch(async (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (backup) {
          await rename(backup, managedRoot)
        }
        await rm(failedRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function restoreLegacySkills(moves: readonly LegacySkillMove[]): Promise<void> {
  for (const move of [...moves].reverse()) {
    await mkdir(dirname(move.target), { recursive: true })
    await rm(move.target, { recursive: true, force: true }).catch(() => undefined)
    await rename(move.backup, move.target)
  }
}

async function assertManagedRoot(path: string): Promise<void> {
  const details = await lstat(path)
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Primary Runtime managed skills path is not a regular directory.')
  }
  let marker: unknown
  try {
    marker = JSON.parse(await readFile(join(path, OWNER_MARKER), 'utf8')) as unknown
  } catch {
    throw new Error('Primary Runtime refuses to replace an unowned Codex skills directory.')
  }
  if (
    !marker ||
    typeof marker !== 'object' ||
    (marker as { owner?: unknown }).owner !== MANAGED_SKILLS_DIRECTORY
  ) {
    throw new Error('Primary Runtime refuses to replace an unowned Codex skills directory.')
  }
}

async function assertRegularTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Primary Runtime bundled skill contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) {
      await assertRegularTree(path)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Primary Runtime bundled skill contains an unsupported entry: ${path}`)
    }
  }
}

function pathInside(root: string, path: string, label: string): string {
  if (!path || isAbsolute(path)) {
    throw new Error(`Primary Runtime ${label} path must stay within the Codex skills directory.`)
  }
  const candidate = resolve(root, path)
  if (!isPathInside(root, candidate)) {
    throw new Error(`Primary Runtime ${label} path must stay within the Codex skills directory.`)
  }
  return candidate
}

function isPathInside(root: string, candidate: string): boolean {
  const distance = relative(root, candidate)
  return distance !== '' && !distance.startsWith('..') && !isAbsolute(distance)
}

function safeDirectoryName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/u.test(value)
}
