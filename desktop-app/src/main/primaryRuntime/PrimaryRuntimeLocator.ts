import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { PrimaryRuntimeActivePointer } from './PrimaryRuntimeActivePointer'

export type PrimaryRuntimeLocatorCandidateKind = 'development' | 'active-cache' | 'packaged'

export type PrimaryRuntimeLocatorCandidate = {
  kind: PrimaryRuntimeLocatorCandidateKind
  path: string
}

export type PrimaryRuntimeLocatorInput = {
  env?: NodeJS.ProcessEnv
  allowDevelopmentRoot?: boolean
  appCacheRoot: string
  resourcesPath?: string
}

export class PrimaryRuntimeLocator {
  private readonly activePointer: PrimaryRuntimeActivePointer

  constructor(private readonly input: PrimaryRuntimeLocatorInput) {
    this.activePointer = new PrimaryRuntimeActivePointer(input.appCacheRoot)
  }

  candidates(): PrimaryRuntimeLocatorCandidate[] {
    const candidates: PrimaryRuntimeLocatorCandidate[] = []
    const developmentRoot = this.input.env?.DASCOWORK_PRIMARY_RUNTIME_ROOT
    if (this.input.allowDevelopmentRoot && developmentRoot && isAbsolute(developmentRoot)) {
      candidates.push({ kind: 'development', path: developmentRoot })
    }

    return candidates
  }

  async locate(): Promise<PrimaryRuntimeLocatorCandidate | null> {
    for (const candidate of this.candidates()) {
      const resolved = await resolveExistingDirectory(candidate.path)
      if (resolved) return { ...candidate, path: resolved }
    }

    const activeRoot = await this.activePointer.resolveRoot().catch(() => null)
    if (activeRoot) return { kind: 'active-cache', path: activeRoot }

    if (this.input.resourcesPath) {
      const packaged = await resolveExistingDirectory(
        join(this.input.resourcesPath, 'primary-runtime')
      )
      if (packaged) return { kind: 'packaged', path: packaged }
    }
    return null
  }
}

async function resolveExistingDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(resolve(path))
    const stats = await stat(resolved)
    return stats.isDirectory() ? resolved : null
  } catch {
    return null
  }
}
