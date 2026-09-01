import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  PLUGIN_CENTER_API_VERSION,
  pluginCenterRecommendedSkillSchema,
  type PluginCenterGetRecommendedSkillsResult,
  type PluginCenterRecommendedSkill
} from '../../shared/pluginCenterApi'
import { runGit } from '../localGit/gitCli'
import { toAppMediaUrl } from '../localMediaProtocol'

const CURATED_SKILLS_REPOSITORY = 'https://github.com/openai/skills.git'
const CURATED_SKILLS_BRANCH = 'main'
const CURATED_SKILLS_PATHS = ['skills/.curated', 'skills/.experimental'] as const
const CURATED_CACHE_FRESH_MS = 10 * 60_000
const GIT_TIMEOUT_MS = 30_000
const GIT_OUTPUT_LIMIT = 512 * 1024

type GitResult = { stdout: string; stderr: string }
type RunGit = (
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number }
) => Promise<GitResult>

type RecommendedSkillsCache = {
  fetchedAt: string
  skills: PluginCenterRecommendedSkill[]
}

type RecommendedSkillsDependencies = {
  codexHome: string
  now?: () => Date
  runGit?: RunGit
  toMediaUrl?: (path: string) => string | null
}

/**
 * Owns the curated OpenAI skills checkout and installation boundary. The
 * renderer only receives display data and may only request an item the service
 * can find again in this server-owned catalog.
 */
export class RecommendedSkillsService {
  private readonly now: () => Date
  private readonly git: RunGit
  private readonly toMediaUrl: (path: string) => string | null
  private inFlight: Promise<PluginCenterGetRecommendedSkillsResult> | null = null

  constructor(private readonly dependencies: RecommendedSkillsDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.git = dependencies.runGit ?? runGit
    this.toMediaUrl = dependencies.toMediaUrl ?? toAppMediaUrl
  }

  async getRecommendedSkills(
    forceRefresh = false
  ): Promise<PluginCenterGetRecommendedSkillsResult> {
    if (this.inFlight) return this.inFlight

    const request = this.loadRecommendedSkills(forceRefresh).finally(() => {
      if (this.inFlight === request) this.inFlight = null
    })
    this.inFlight = request
    return request
  }

  async installRecommendedSkill(input: {
    id: string
    repoPath: string
  }): Promise<'installed' | 'already-installed'> {
    const catalog = await this.getRecommendedSkills()
    const skill = catalog.skills.find(
      (candidate) => candidate.id === input.id && candidate.repoPath === input.repoPath
    )
    if (!skill) throw new Error('The requested recommended skill is no longer available')
    if (!isSafeSkillDirectoryName(skill.id))
      throw new Error('The recommended skill has an invalid id')

    const sourceDirectory = resolveContainedPath(this.checkoutPath, skill.repoPath)
    const targetDirectory = resolveContainedPath(this.skillsPath, skill.id)
    await assertInstallableSkillSource(sourceDirectory)

    if (await pathExists(targetDirectory)) return 'already-installed'

    await mkdir(this.skillsPath, { recursive: true })
    const temporaryDirectory = resolveContainedPath(
      this.skillsPath,
      `.${skill.id}.install-${randomUUID()}`
    )
    let installed = false
    try {
      await copyDirectoryWithoutLinks(sourceDirectory, temporaryDirectory)
      await rename(temporaryDirectory, targetDirectory)
      installed = true
      return 'installed'
    } finally {
      if (!installed) await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  private get vendorImportsPath(): string {
    return resolve(this.dependencies.codexHome, 'vendor_imports')
  }

  private get checkoutPath(): string {
    return resolve(this.vendorImportsPath, 'skills')
  }

  private get cachePath(): string {
    return resolve(this.vendorImportsPath, 'skills-curated-cache.json')
  }

  private get skillsPath(): string {
    return resolve(this.dependencies.codexHome, 'skills')
  }

  private async loadRecommendedSkills(
    forceRefresh: boolean
  ): Promise<PluginCenterGetRecommendedSkillsResult> {
    const cached = await this.readCache()
    if (
      !forceRefresh &&
      cached &&
      this.now().getTime() - Date.parse(cached.fetchedAt) < CURATED_CACHE_FRESH_MS
    ) {
      return resultFromCache(cached, 'cache')
    }

    try {
      await this.refreshCheckout()
      const skills = await this.scanCheckout()
      const cache: RecommendedSkillsCache = { fetchedAt: this.now().toISOString(), skills }
      await this.writeCache(cache)
      return resultFromCache(cache, 'git')
    } catch {
      if (cached) {
        return resultFromCache(
          cached,
          'cache',
          '推荐技能目录暂时不可用，正在显示最近一次成功加载的内容。'
        )
      }
      return {
        version: PLUGIN_CENTER_API_VERSION,
        skills: [],
        fetchedAt: this.now().toISOString(),
        source: 'cache',
        error: '推荐技能目录暂时不可用，请重试。'
      }
    }
  }

  private async refreshCheckout(): Promise<void> {
    if (!(await pathExists(this.checkoutPath))) {
      await mkdir(this.vendorImportsPath, { recursive: true })
      await this.runGit(this.vendorImportsPath, [
        'clone',
        '--depth=1',
        '--filter=blob:none',
        '--sparse',
        '--branch',
        CURATED_SKILLS_BRANCH,
        CURATED_SKILLS_REPOSITORY,
        'skills'
      ])
    } else {
      await this.assertControlledCheckout()
      await this.runGit(this.checkoutPath, ['fetch', '--depth=1', 'origin', CURATED_SKILLS_BRANCH])
      // This reset is restricted to a checkout whose origin was verified above.
      await this.runGit(this.checkoutPath, ['reset', '--hard', 'FETCH_HEAD'])
    }
    await this.runGit(this.checkoutPath, [
      'sparse-checkout',
      'set',
      '--no-cone',
      ...CURATED_SKILLS_PATHS
    ])
  }

  private async assertControlledCheckout(): Promise<void> {
    const [insideWorkTree, remote] = await Promise.all([
      this.runGit(this.checkoutPath, ['rev-parse', '--is-inside-work-tree']),
      this.runGit(this.checkoutPath, ['remote', 'get-url', 'origin'])
    ])
    if (
      insideWorkTree.stdout.trim() !== 'true' ||
      remote.stdout.trim() !== CURATED_SKILLS_REPOSITORY
    ) {
      throw new Error('Recommended skills cache is not a controlled checkout')
    }
  }

  private async runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
    return this.git(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: GIT_OUTPUT_LIMIT })
  }

  private async scanCheckout(): Promise<PluginCenterRecommendedSkill[]> {
    const byId = new Map<string, PluginCenterRecommendedSkill>()
    for (const root of CURATED_SKILLS_PATHS) {
      const absoluteRoot = resolveContainedPath(this.checkoutPath, root)
      for (const directory of await skillDirectories(absoluteRoot)) {
        const skill = await parseRecommendedSkill(this.checkoutPath, directory, this.toMediaUrl)
        if (skill && !byId.has(skill.id)) byId.set(skill.id, skill)
      }
    }
    return [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    )
  }

  private async readCache(): Promise<RecommendedSkillsCache | null> {
    try {
      const raw = JSON.parse(await readFile(this.cachePath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object') return null
      const value = raw as { fetchedAt?: unknown; skills?: unknown }
      if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) {
        return null
      }
      if (!Array.isArray(value.skills)) return null
      const skills = value.skills.flatMap((skill) => {
        const parsed = pluginCenterRecommendedSkillSchema.safeParse(skill)
        return parsed.success ? [parsed.data] : []
      })
      if (skills.length !== value.skills.length) return null
      return { fetchedAt: value.fetchedAt, skills }
    } catch {
      return null
    }
  }

  private async writeCache(cache: RecommendedSkillsCache): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    const temporaryPath = `${this.cachePath}.tmp-${randomUUID()}`
    try {
      await writeFile(temporaryPath, JSON.stringify(cache), 'utf8')
      await rename(temporaryPath, this.cachePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
}

function resultFromCache(
  cache: RecommendedSkillsCache,
  source: 'git' | 'cache',
  error?: string
): PluginCenterGetRecommendedSkillsResult {
  return {
    version: PLUGIN_CENTER_API_VERSION,
    skills: cache.skills,
    fetchedAt: cache.fetchedAt,
    source,
    ...(error ? { error } : {})
  }
}

async function skillDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => resolve(root, entry.name))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

async function parseRecommendedSkill(
  checkoutPath: string,
  directory: string,
  toMediaUrl: (path: string) => string | null
): Promise<PluginCenterRecommendedSkill | null> {
  const skillPath = resolve(directory, 'SKILL.md')
  let contents: string
  try {
    contents = await readFile(skillPath, 'utf8')
  } catch {
    return null
  }

  const frontmatter = parseFrontmatter(contents)
  const interfaceInfo = await parseOpenAiInterface(directory)
  const id = frontmatter.name ?? basename(directory)
  if (!isSafeSkillDirectoryName(id)) return null
  const repoPath = toPosixRelativePath(checkoutPath, directory)
  if (!repoPath) return null
  const iconSmall = iconFromMetadata(interfaceInfo.iconSmall, directory, toMediaUrl)
  const iconLarge = iconFromMetadata(interfaceInfo.iconLarge, directory, toMediaUrl)
  const parsed = pluginCenterRecommendedSkillSchema.safeParse({
    id,
    name: interfaceInfo.displayName ?? id,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(interfaceInfo.shortDescription ? { shortDescription: interfaceInfo.shortDescription } : {}),
    ...(iconSmall ? { iconSmall } : {}),
    ...(iconLarge ? { iconLarge } : {}),
    repoPath
  })
  return parsed.success ? parsed.data : null
}

function parseFrontmatter(contents: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)
  if (!match) return {}
  return {
    name: yamlScalar(match[1], 'name'),
    description: yamlScalar(match[1], 'description')
  }
}

async function parseOpenAiInterface(directory: string): Promise<{
  displayName?: string
  shortDescription?: string
  iconSmall?: string
  iconLarge?: string
}> {
  try {
    const yaml = await readFile(resolve(directory, 'agents', 'openai.yaml'), 'utf8')
    return {
      displayName: yamlScalar(yaml, 'display_name') ?? yamlScalar(yaml, 'displayName'),
      shortDescription:
        yamlScalar(yaml, 'short_description') ?? yamlScalar(yaml, 'shortDescription'),
      iconSmall: yamlScalar(yaml, 'icon_small') ?? yamlScalar(yaml, 'iconSmall'),
      iconLarge: yamlScalar(yaml, 'icon_large') ?? yamlScalar(yaml, 'iconLarge')
    }
  } catch {
    return {}
  }
}

function yamlScalar(source: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, 'm').exec(source)
  if (!match) return undefined
  const value = match[1].replace(/\s+#.*$/, '').trim()
  if (!value || value === '|' || value === '>') return undefined
  const unquoted = value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2').trim()
  return unquoted || undefined
}

function iconFromMetadata(
  value: string | undefined,
  directory: string,
  toMediaUrl: (path: string) => string | null
): { kind: 'url'; value: string } | undefined {
  if (!value || isAbsolute(value)) return undefined
  try {
    const iconPath = resolveContainedPath(directory, value)
    const url = toMediaUrl(iconPath)
    return url ? { kind: 'url', value: url } : undefined
  } catch {
    return undefined
  }
}

function isSafeSkillDirectoryName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(value)
}

function toPosixRelativePath(root: string, path: string): string | null {
  const value = relative(root, path)
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) return null
  return value.split(sep).join('/')
}

function resolveContainedPath(root: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error('Path must be relative')
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, value)
  const pathRelative = relative(resolvedRoot, resolvedPath)
  if (
    !pathRelative ||
    pathRelative === '..' ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new Error('Path escapes its allowed root')
  }
  return resolvedPath
}

async function assertInstallableSkillSource(sourceDirectory: string): Promise<void> {
  const [source, skill] = await Promise.all([
    lstat(sourceDirectory),
    lstat(resolve(sourceDirectory, 'SKILL.md'))
  ])
  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    !skill.isFile() ||
    skill.isSymbolicLink()
  ) {
    throw new Error('Recommended skill source is invalid')
  }
}

async function copyDirectoryWithoutLinks(source: string, destination: string): Promise<void> {
  const sourceStats = await lstat(source)
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error('Recommended skill source contains an unsupported directory')
  }
  await mkdir(destination, { recursive: false })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name)
    const destinationPath = resolve(destination, entry.name)
    const stats = await lstat(sourcePath)
    if (stats.isSymbolicLink()) throw new Error('Recommended skill source contains a symbolic link')
    if (stats.isDirectory()) {
      await copyDirectoryWithoutLinks(sourcePath, destinationPath)
    } else if (stats.isFile()) {
      await copyFile(sourcePath, destinationPath, 0)
    } else {
      throw new Error('Recommended skill source contains an unsupported file')
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
