import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  GitManager,
  GitReviewSnapshotStaleError,
  type GitHost,
  type GitRunResult
} from './GitManager'
import type { GitRepositoryTargetResolver } from './GitRepositoryTargetResolver'
import { LocalGitService } from './LocalGitService'
import { computeWorkspaceStateHash, InMemorySnapshotGenerationStore } from './reviewSnapshot'
import { git, createGitFixture, gitTarget } from './testHelpers'
import {
  LOCAL_GIT_PATCH_MAX_CHARACTERS,
  LOCAL_GIT_REVIEW_CONTENT_MAX_BYTES
} from '../../shared/localGitApi'

describe('LocalGitService', () => {
  it('derives watch snapshots and working-tree paths from one consistent status sample', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'changed\n')
    await writeFile(join(repo, 'untracked.txt'), 'new\n')
    const snapshots = new InMemorySnapshotGenerationStore()
    const service = new LocalGitService({ projectService, snapshots })
    const target = gitTarget(repo)

    const watchState = await service.getWatchState(target)
    const repository = (await service.resolveTrustedRepository(target)).repository

    expect(snapshots.get(watchState.snapshotGeneration)?.stateHash).toBe(
      await computeWorkspaceStateHash(repository)
    )
    expect(watchState.workingTreePaths).toEqual(['tracked.txt', 'untracked.txt'])
  })

  it('retries a snapshot once when a Git change notification invalidates the initial read', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const { repository } = await service.resolveTrustedRepository(target)
    const initialReviewSnapshot = repository.reviewSnapshot
    const initialRead = vi.spyOn(initialReviewSnapshot, 'read')

    initialRead.mockImplementationOnce(async () => {
      repository.invalidateGitReadCachesForRepoChange('working-tree')
      throw new GitReviewSnapshotStaleError()
    })

    await expect(service.getSnapshot(target, { type: 'unstaged' })).resolves.toMatchObject({
      gitRoot: repo,
      files: [expect.objectContaining({ path: 'tracked.txt' })]
    })
    expect(initialRead).toHaveBeenCalledOnce()
    expect(repository.reviewSnapshot.generation).toBe(1)
  })

  it('returns a stale file-diff result when the signed review snapshot is retired', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const { repository } = await service.resolveTrustedRepository(target)

    repository.invalidateGitReadCachesForRepoChange('working-tree')

    await expect(
      service.getFileDiff({
        target,
        source: snapshot.source,
        snapshotGeneration: snapshot.snapshotGeneration,
        file: snapshot.files[0]
      })
    ).resolves.toEqual({ status: 'stale' })
    await expect(
      service.getReviewFileContent({
        target,
        source: snapshot.source,
        snapshotGeneration: snapshot.snapshotGeneration,
        file: snapshot.files[0],
        side: 'after'
      })
    ).resolves.toEqual({ status: 'stale' })
    await expect(
      service.getReviewDiffFileContents({
        target,
        source: snapshot.source,
        snapshotGeneration: snapshot.snapshotGeneration,
        file: snapshot.files[0]
      })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('keeps a staged snapshot valid while reading its file diff', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\nstaged\n')
    git(repo, ['add', 'tracked.txt'])
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'staged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'tracked.txt')
    expect(file).toBeDefined()

    await expect(
      service.getFileDiff({
        target,
        source: snapshot.source,
        snapshotGeneration: snapshot.snapshotGeneration,
        file: file!
      })
    ).resolves.toMatchObject({
      status: 'ready',
      snapshotGeneration: snapshot.snapshotGeneration,
      file: { path: 'tracked.txt', revision: file!.revision }
    })
  })

  it('returns a stale file-diff result when the snapshot retires during the read', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const { repository } = await service.resolveTrustedRepository(target)

    vi.spyOn(repository.reviewSnapshot, 'read').mockImplementationOnce(async () => {
      repository.invalidateGitReadCachesForRepoChange('working-tree')
      throw new GitReviewSnapshotStaleError()
    })

    await expect(
      service.getFileDiff({
        target,
        source: snapshot.source,
        snapshotGeneration: snapshot.snapshotGeneration,
        file: snapshot.files[0]
      })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('creates a trusted unstaged snapshot and stages only with matching revisions', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })

    const snapshot = await service.getSnapshot(gitTarget(repo), { type: 'unstaged' })

    expect(snapshot.gitRoot).toBe(repo)
    expect(snapshot.files).toMatchObject([{ path: 'tracked.txt', additions: 1 }])

    const result = await service.mutateReview({
      target: gitTarget(repo),
      source: { type: 'unstaged' },
      snapshotGeneration: snapshot.snapshotGeneration,
      action: 'stage',
      scope: 'file',
      files: [{ path: 'tracked.txt', revision: snapshot.files[0].revision }]
    })

    expect(result.status).toBe('success')
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('tracked.txt')
  })

  it('reads Markdown preview content through a signed review snapshot', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'notes.md'), '# Signed preview\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'notes.md')
    expect(file).toBeDefined()

    await expect(
      service.getReviewFileContent({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: file!.revision },
        side: 'after'
      })
    ).resolves.toEqual({ status: 'text', mimeType: 'text/markdown', text: '# Signed preview\n' })

    await expect(
      service.getReviewFileContent({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: 'not-the-signed-revision' },
        side: 'after'
      })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('reads both signed source-file revisions for expandable unchanged diff context', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'source.ts'), 'const value = 1\nconst stable = true\n')
    git(repo, ['add', 'source.ts'])
    git(repo, ['commit', '-m', 'add source file'])
    await writeFile(join(repo, 'source.ts'), 'const value = 2\nconst stable = true\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'source.ts')
    expect(file).toBeDefined()

    await expect(
      service.getReviewDiffFileContents({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: file!.revision }
      })
    ).resolves.toEqual({
      status: 'text',
      before: 'const value = 1\nconst stable = true\n',
      after: 'const value = 2\nconst stable = true\n'
    })

    await expect(
      service.getReviewDiffFileContents({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: 'not-the-signed-revision' }
      })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('reconstructs expandable context for a completed-turn patch that still matches the worktree', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'source.ts'), 'const value = 1\nconst stable = true\n')
    git(repo, ['add', 'source.ts'])
    git(repo, ['commit', '-m', 'add source file'])
    await writeFile(join(repo, 'source.ts'), 'const value = 2\nconst stable = true\n')
    const diff = git(repo, ['diff', '--', 'source.ts'])
    const turnDiffStore = {
      read: vi.fn(async (threadId: string, turnId: string) =>
        threadId === 'thread1' && turnId === 'turn-1' ? diff : undefined
      )
    }
    const service = new LocalGitService({ projectService, turnDiffStore })

    await expect(
      service.getTurnDiffFileContents({
        target: gitTarget(repo, 'thread1', 'thread1'),
        turnId: 'turn-1',
        path: 'source.ts'
      })
    ).resolves.toEqual({
      status: 'text',
      before: 'const value = 1\nconst stable = true\n',
      after: 'const value = 2\nconst stable = true\n'
    })
    expect(turnDiffStore.read).toHaveBeenCalledWith('thread1', 'turn-1')

    await expect(
      service.getTurnDiffFileContents({
        target: gitTarget(repo, 'thread1', 'thread1'),
        turnId: 'missing-turn',
        path: 'source.ts'
      })
    ).resolves.toMatchObject({ status: 'unsupported' })
    await expect(
      service.getTurnDiffFileContents({
        target: gitTarget(repo, 'thread1', 'thread1'),
        turnId: 'turn-1',
        path: 'unrelated.ts'
      })
    ).resolves.toMatchObject({ status: 'unsupported' })
  }, 15_000)

  it('exports a stable git apply command from the signed review snapshot', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    const result = await service.getReviewApplyCommand({
      target,
      source: { type: 'unstaged' },
      snapshotGeneration: snapshot.snapshotGeneration
    })

    expect(result.snapshotGeneration).toBe(snapshot.snapshotGeneration)
    expect(result.source).toEqual({ type: 'unstaged' })
    expect(result.command).toMatch(
      /^git apply --whitespace=nowarn - <<'CODEX_REVIEW_PATCH_[A-F0-9]+'/u
    )
    expect(result.command).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(result.command).toContain('+two')
  })

  it('returns raw image bytes as a bounded media payload instead of decoding binary content as text', async () => {
    const { repo, projectService } = await createGitFixture()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255])
    await writeFile(join(repo, 'preview.png'), bytes)
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'preview.png')
    expect(file).toBeDefined()

    await expect(
      service.getReviewFileContent({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: file!.revision },
        side: 'after'
      })
    ).resolves.toEqual({ status: 'media', mimeType: 'image/png', base64: bytes.toString('base64') })
  })

  it('bounds worktree rich-preview reads before encoding media or text', async () => {
    const { repo, projectService } = await createGitFixture()
    const initialContent = `${'a'.repeat(4096)}\n`.repeat(
      Math.ceil((LOCAL_GIT_REVIEW_CONTENT_MAX_BYTES + 2) / 4097)
    )
    const changedContent = `b${initialContent.slice(1)}`
    await writeFile(join(repo, 'large.md'), initialContent)
    git(repo, ['add', 'large.md'])
    git(repo, ['commit', '-m', 'add large preview fixture'])
    await writeFile(join(repo, 'large.md'), changedContent)
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'large.md')
    expect(file).toBeDefined()

    await expect(
      service.getReviewFileContent({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: file!.revision },
        side: 'after'
      })
    ).resolves.toEqual({ status: 'too-large', maxBytes: LOCAL_GIT_REVIEW_CONTENT_MAX_BYTES })
  })

  it('does not follow worktree preview symlinks outside the repository', async () => {
    const { repo, projectService } = await createGitFixture()
    const outside = join(repo, '..', 'outside-preview.md')
    await writeFile(outside, '# Private content\n')
    await symlink(outside, join(repo, 'outside-link.md'))
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'outside-link.md')
    expect(file).toBeDefined()

    await expect(
      service.getReviewFileContent({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: file!.path, revision: file!.revision },
        side: 'after'
      })
    ).resolves.toEqual({
      status: 'unsupported',
      reason: '当前审阅来源没有可读取的文件内容。'
    })
  })

  it('refreshes only written review paths while preserving untouched files in the next snapshot', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'second.txt'), 'second\n')
    git(repo, ['add', 'second.txt'])
    git(repo, ['commit', '-m', 'add second file'])
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    await writeFile(join(repo, 'second.txt'), 'second\nchanged\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const written = snapshot.files.find((file) => file.path === 'tracked.txt')
    const untouched = snapshot.files.find((file) => file.path === 'second.txt')
    expect(written).toBeDefined()
    expect(untouched).toBeDefined()

    await expect(
      service.mutateReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        action: 'stage',
        scope: 'file',
        files: [{ path: written!.path, revision: written!.revision }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['tracked.txt'] })

    const refreshed = await service.refreshReviewFiles({
      target,
      source: { type: 'unstaged' },
      snapshotGeneration: snapshot.snapshotGeneration,
      paths: ['tracked.txt']
    })

    expect(refreshed.snapshotGeneration).not.toBe(snapshot.snapshotGeneration)
    expect(refreshed.files).toEqual([])
    await expect(
      service.getFileDiff({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: refreshed.snapshotGeneration,
        file: {
          path: untouched!.path,
          revision: untouched!.revision
        }
      })
    ).resolves.toMatchObject({ status: 'ready', file: { path: 'second.txt' } })
    await expect(
      service.getFileDiff({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: refreshed.snapshotGeneration,
        file: {
          path: written!.path,
          revision: written!.revision
        }
      })
    ).resolves.toEqual({ status: 'stale' })
  })

  it('rejects review mutation targets that do not exactly match their signed snapshot', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'second.txt'), 'second\n')
    git(repo, ['add', 'second.txt'])
    git(repo, ['commit', '-m', 'add second file'])
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    await writeFile(join(repo, 'second.txt'), 'second\nchanged\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    const [first, second] = snapshot.files
    expect(first).toBeDefined()
    expect(second).toBeDefined()

    const invalidTargets = [
      [first!],
      [...snapshot.files, { path: 'missing.txt', revision: 'forged' }],
      [first!, first!],
      snapshot.files.map((file, index) =>
        index === 0 ? { ...file, revision: 'forged-revision' } : file
      ),
      snapshot.files.map((file, index) =>
        index === 0 ? { ...file, previousPath: 'forged-previous-path' } : file
      )
    ]

    for (const files of invalidTargets) {
      await expect(
        service.mutateReview({
          target,
          source: { type: 'unstaged' },
          snapshotGeneration: snapshot.snapshotGeneration,
          action: 'stage',
          scope: 'section',
          files: files.map((file) => ({
            path: file.path,
            ...('previousPath' in file && file.previousPath !== undefined
              ? { previousPath: file.previousPath }
              : {}),
            revision: file.revision
          }))
        })
      ).resolves.toMatchObject({ status: 'error', errorCode: 'stale-snapshot' })
    }

    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })

  it('rejects a section atomically when any signed file revision has drifted', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'second.txt'), 'second\n')
    git(repo, ['add', 'second.txt'])
    git(repo, ['commit', '-m', 'add second file'])
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    await writeFile(join(repo, 'second.txt'), 'second\nchanged\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })
    await writeFile(join(repo, 'second.txt'), 'second\nchanged again\n')

    await expect(
      service.mutateReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        action: 'stage',
        scope: 'section',
        files: snapshot.files.map(({ path, previousPath, revision }) => ({
          path,
          ...(previousPath === undefined ? {} : { previousPath }),
          revision
        }))
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'stale-snapshot' })

    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })

  it('rejects an oversized review section patch before writing any file', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'second.txt'), 'second\n')
    git(repo, ['add', 'second.txt'])
    git(repo, ['commit', '-m', 'add second file'])
    const largeChange = `${'x'.repeat(Math.ceil(LOCAL_GIT_PATCH_MAX_CHARACTERS / 2))}\n`
    await writeFile(join(repo, 'tracked.txt'), largeChange)
    await writeFile(join(repo, 'second.txt'), largeChange)
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    await expect(
      service.mutateReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        action: 'stage',
        scope: 'section',
        files: snapshot.files.map(({ path, previousPath, revision }) => ({
          path,
          ...(previousPath === undefined ? {} : { previousPath }),
          revision
        }))
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'patch-too-large' })

    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })

  it('lists bounded local commit summaries from the trusted repository', async () => {
    const { repo, projectService } = await createGitFixture()
    const service = new LocalGitService({ projectService })

    await expect(service.listCommits(gitTarget(repo), 1)).resolves.toMatchObject([
      { subject: 'initial' }
    ])
  })

  it('P004-EDGE-09/P004-EDGE-10 rejects review mutation after the file revision drifts', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const snapshot = await service.getSnapshot(gitTarget(repo), { type: 'unstaged' })
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\nthree\n')

    const result = await service.mutateReview({
      target: gitTarget(repo),
      source: { type: 'unstaged' },
      snapshotGeneration: snapshot.snapshotGeneration,
      action: 'stage',
      scope: 'file',
      files: [{ path: 'tracked.txt', revision: snapshot.files[0].revision }]
    })

    expect(result).toMatchObject({ status: 'error', errorCode: 'stale-snapshot' })
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })

  it('rejects a signed snapshot when a request changes its review source', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const service = new LocalGitService({ projectService })
    const snapshot = await service.getSnapshot(gitTarget(repo), { type: 'unstaged' })

    await expect(
      service.mutateReview({
        target: gitTarget(repo),
        source: { type: 'staged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        action: 'unstage',
        scope: 'file',
        files: [{ path: 'tracked.txt', revision: snapshot.files[0].revision }]
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'stale-snapshot' })
    await expect(
      service.getFileDiff({
        target: gitTarget(repo),
        source: { type: 'staged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        file: { path: 'tracked.txt', revision: snapshot.files[0].revision }
      })
    ).resolves.toEqual({ status: 'stale' })
    await expect(
      service.searchReview({
        target: gitTarget(repo),
        source: { type: 'staged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'two'
      })
    ).rejects.toThrow('stale-snapshot')
  })

  it('returns an identity-preserving empty review search result without resolving Git', async () => {
    const target = gitTarget('/repo')
    const service = new LocalGitService({
      targetResolver: {
        assertRepository: async () => {
          throw new Error('empty query must not resolve a repository')
        }
      } as unknown as GitRepositoryTargetResolver
    })

    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: 'generation',
        query: '   '
      })
    ).resolves.toEqual({
      snapshotGeneration: 'generation',
      source: { type: 'unstaged' },
      items: [],
      totalMatches: 0,
      isCapped: false
    })
  })

  it('searches review patches with structured locations while ignoring generated paths', async () => {
    const { repo, projectService } = await createGitFixture()
    await mkdir(join(repo, 'src'), { recursive: true })
    await mkdir(join(repo, 'dist'), { recursive: true })
    await writeFile(join(repo, 'src', 'main.ts'), 'const value = "needle"\n')
    await writeFile(join(repo, 'dist', 'generated.js'), 'const value = "needle"\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'needle'
      })
    ).resolves.toMatchObject({
      snapshotGeneration: snapshot.snapshotGeneration,
      source: { type: 'unstaged' },
      totalMatches: 1,
      isCapped: false,
      items: [
        {
          path: 'src/main.ts',
          side: 'additions',
          lineStart: 1,
          lineEnd: 1,
          snippet: { match: '+const value = "needle"' }
        }
      ]
    })
  })

  it('reports deletion and addition search matches with their own line coordinates', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'needle old\nsecond\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-m', 'add search side fixture'])
    await writeFile(join(repo, 'tracked.txt'), 'replacement\nsecond\n')
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'needle'
      })
    ).resolves.toMatchObject({
      items: [{ path: 'tracked.txt', side: 'deletions', lineStart: 1, lineEnd: 1 }]
    })
    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'replacement'
      })
    ).resolves.toMatchObject({
      items: [{ path: 'tracked.txt', side: 'additions', lineStart: 1, lineEnd: 1 }]
    })
  })

  it('caps review search results at the shared limit while preserving total matches', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(
      join(repo, 'tracked.txt'),
      Array.from({ length: 260 }, (_, index) => `needle ${index}`).join('\n') + '\n'
    )
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'needle'
      })
    ).resolves.toMatchObject({
      totalMatches: 260,
      isCapped: true,
      items: expect.arrayContaining([
        expect.objectContaining({
          path: 'tracked.txt',
          hunkId: expect.stringContaining('@@'),
          patchOffset: expect.any(Number),
          snippet: expect.objectContaining({ match: expect.stringContaining('needle') })
        })
      ])
    })
  })

  it('searches a 2 MiB text diff without inheriting the snapshot size cap', async () => {
    const { repo, projectService } = await createGitFixture()
    const base = 'A'.repeat(2 * 1024 * 1024)
    await writeFile(join(repo, 'large-search.txt'), base)
    git(repo, ['add', 'large-search.txt'])
    git(repo, ['commit', '-m', 'add large review search fixture'])
    await writeFile(join(repo, 'large-search.txt'), `needle${'B'.repeat(2 * 1024 * 1024 - 6)}`)
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const snapshot = await service.getSnapshot(target, { type: 'unstaged' })

    await expect(
      service.searchReview({
        target,
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        query: 'needle'
      })
    ).resolves.toMatchObject({
      totalMatches: 1,
      items: [expect.objectContaining({ path: 'large-search.txt', side: 'additions' })]
    })
  })

  it('stages an untracked file from the signed review snapshot', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'new.txt'), 'new file\n')
    const service = new LocalGitService({ projectService })
    await expect(service.getSummary(gitTarget(repo))).resolves.toMatchObject({
      untrackedFileCount: 1,
      additions: 1,
      deletions: 0
    })
    const snapshot = await service.getSnapshot(gitTarget(repo), { type: 'unstaged' })
    const file = snapshot.files.find((candidate) => candidate.path === 'new.txt')
    expect(file).toBeDefined()

    await expect(
      service.mutateReview({
        target: gitTarget(repo),
        source: { type: 'unstaged' },
        snapshotGeneration: snapshot.snapshotGeneration,
        action: 'stage',
        scope: 'file',
        files: [{ path: 'new.txt', revision: file!.revision }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['new.txt'] })
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('new.txt')
  })

  it('uses one canonical all-untracked read for summary and workspace state', async () => {
    const commands: string[] = []
    const host = createHost({
      async runGit(args) {
        const command = args.join(' ')
        commands.push(command)
        if (command === 'ls-files --others --exclude-standard -z') return ok('new.txt\0')
        if (command === 'diff --no-index --numstat /dev/null new.txt') {
          return ok('1\t0\tnew.txt\n')
        }
        if (
          [
            'diff --cached --name-only',
            'diff --name-only',
            'diff --numstat',
            'diff --cached --numstat',
            'diff --raw -z',
            'diff --cached --raw -z'
          ].includes(command)
        ) {
          return ok('')
        }
        if (command === 'branch --show-current') return ok('main\n')
        if (command === 'rev-parse HEAD') return ok('abc123\n')
        return fail(`unexpected command: ${command}`)
      }
    })
    const repository = new GitManager().getWorktreeRepositoryForRoot('/repo', host)
    const target = gitTarget('/repo')
    const service = new LocalGitService({
      targetResolver: {
        assertRepository: async () => ({ target, repository })
      } as unknown as GitRepositoryTargetResolver
    })

    await expect(service.getSummary(target)).resolves.toMatchObject({
      untrackedFileCount: 1,
      additions: 1,
      deletions: 0,
      branch: 'main'
    })

    expect(
      commands.filter((command) => command === 'ls-files --others --exclude-standard -z')
    ).toHaveLength(1)
  })

  it('undoes and reapplies turn patch batches', async () => {
    const { repo, projectService } = await createGitFixture()
    await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n')
    const patch = git(repo, ['diff', '--binary'])
    const service = new LocalGitService({ projectService })

    await expect(
      service.applyTurnPatch({
        target: gitTarget(repo),
        action: 'undo',
        turnId: 'turn_1',
        batches: [{ cwd: repo, gitRoot: repo, diff: patch }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['tracked.txt'] })
    await expect(readFile(join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('one\n')

    await expect(
      service.applyTurnPatch({
        target: gitTarget(repo),
        action: 'reapply',
        turnId: 'turn_1',
        batches: [{ cwd: repo, gitRoot: repo, diff: patch }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['tracked.txt'] })
    await expect(readFile(join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('one\ntwo\n')
  })

  it('applies a subdirectory turn patch from its trusted batch cwd', async () => {
    const { repo, projectService } = await createGitFixture()
    const batchCwd = join(repo, 'packages', 'app')
    const path = join(batchCwd, 'tracked.txt')
    await mkdir(batchCwd, { recursive: true })
    await writeFile(path, 'one\n')
    git(repo, ['add', 'packages/app/tracked.txt'])
    git(repo, ['commit', '-m', 'add nested file'])
    await writeFile(path, 'one\ntwo\n')
    const patch = git(repo, ['diff', '--binary']).replaceAll(
      'packages/app/tracked.txt',
      'tracked.txt'
    )
    const service = new LocalGitService({ projectService })
    const target = gitTarget(repo)
    const repository = (await service.resolveTrustedRepository(target)).repository
    const initialGeneration = repository.gitReadGeneration

    await expect(
      service.applyTurnPatch({
        target,
        action: 'undo',
        turnId: 'turn_1',
        batches: [{ cwd: batchCwd, gitRoot: repo, diff: patch }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['tracked.txt'] })
    await expect(readFile(path, 'utf8')).resolves.toBe('one\n')
    expect(repository.gitReadGeneration).toBe(initialGeneration + 1)

    await expect(
      service.applyTurnPatch({
        target,
        action: 'reapply',
        turnId: 'turn_1',
        batches: [{ cwd: batchCwd, gitRoot: repo, diff: patch }]
      })
    ).resolves.toMatchObject({ status: 'success', appliedPaths: ['tracked.txt'] })
    await expect(readFile(path, 'utf8')).resolves.toBe('one\ntwo\n')
    expect(repository.gitReadGeneration).toBe(initialGeneration + 2)
  })

  it('rejects a turn patch batch from a nested Git worktree', async () => {
    const { repo, projectService } = await createGitFixture()
    const batchCwd = join(repo, 'nested-repository')
    await mkdir(batchCwd)
    git(batchCwd, ['init'])
    const service = new LocalGitService({ projectService })
    const patch = [
      'diff --git a/tracked.txt b/tracked.txt',
      '--- a/tracked.txt',
      '+++ b/tracked.txt',
      '@@ -1 +1 @@',
      '-one',
      '+two',
      ''
    ].join('\n')

    await expect(
      service.applyTurnPatch({
        target: gitTarget(repo),
        action: 'reapply',
        turnId: 'turn_1',
        batches: [{ cwd: batchCwd, gitRoot: repo, diff: patch }]
      })
    ).rejects.toThrow('turn patch cwd git root does not match trusted repository')
  })

  it('rejects review writes from immutable comparison sources', async () => {
    const target = gitTarget('/repo')
    const service = new LocalGitService({
      targetResolver: {
        assertRepository: async () => {
          throw new Error('immutable review writes must not resolve a repository')
        }
      } as unknown as GitRepositoryTargetResolver
    })

    await expect(
      service.mutateReview({
        target,
        source: { type: 'commit', commitSha: 'a'.repeat(40) },
        snapshotGeneration: 'snapshot',
        action: 'revert',
        scope: 'file',
        files: [{ path: 'tracked.txt', revision: 'revision' }]
      })
    ).resolves.toMatchObject({ status: 'error', errorCode: 'unsupported-review-source-action' })
  })

  it('resolves a fixed merge base only from the trusted conversation repository', async () => {
    const { repo, projectService } = await createGitFixture()
    const baseBranch = git(repo, ['branch', '--show-current']).trim()
    git(repo, ['checkout', '-b', 'feature/review'])
    await writeFile(join(repo, 'tracked.txt'), 'feature\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-m', 'feature change'])
    const service = new LocalGitService({ projectService })

    await expect(service.resolveMergeBase(gitTarget(repo), baseBranch)).resolves.toEqual({
      baseBranch,
      mergeBase: git(repo, ['merge-base', baseBranch, 'HEAD']).trim()
    })
  })
})

function createHost(overrides: Partial<GitHost>): GitHost {
  return {
    id: 'local',
    isLocal: true,
    runGit: async () => ok(''),
    ...overrides
  }
}

function ok(stdout: string): GitRunResult {
  return { success: true, code: 0, stdout, stderr: '' }
}

function fail(stderr: string): GitRunResult {
  return { success: false, code: 1, stdout: '', stderr }
}
