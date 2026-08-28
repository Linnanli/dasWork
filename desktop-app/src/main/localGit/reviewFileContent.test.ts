import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { GitManager } from './GitManager'
import { LocalGitHost } from './GitHostRegistry'
import {
  readReviewDiffFileContents,
  readReviewFileContent,
  readReviewTurnDiffFileContents
} from './reviewFileContent'
import { createGitFixture, git } from './testHelpers'

describe('reviewFileContent', () => {
  it('reads complete UTF-8 source files for inline unchanged-context expansion', async () => {
    const { repo } = await createGitFixture()
    await writeFile(join(repo, 'src.ts'), 'const value = 1\nconst stable = true\n')
    git(repo, ['add', 'src.ts'])
    git(repo, ['commit', '-m', 'add source file'])
    await writeFile(join(repo, 'src.ts'), 'const value = 2\nconst stable = true\n')

    const repository = new GitManager().getWorktreeRepositoryForRoot(repo, new LocalGitHost())
    const content = await readReviewDiffFileContents({
      repository,
      source: { type: 'unstaged' },
      file: {
        path: 'src.ts',
        changeKind: 'modified',
        revision: 'test',
        additions: 1,
        deletions: 1,
        binary: false,
        conflicted: false
      }
    })

    expect(content).toEqual({
      status: 'text',
      before: 'const value = 1\nconst stable = true\n',
      after: 'const value = 2\nconst stable = true\n'
    })
  }, 30_000)

  it('reads branch before content from the merge-base revision', async () => {
    const { repo } = await createGitFixture()
    await writeFile(join(repo, 'notes.md'), 'base\n')
    git(repo, ['add', 'notes.md'])
    git(repo, ['commit', '-m', 'add markdown file'])
    const baseBranch = git(repo, ['branch', '--show-current']).trim()

    git(repo, ['checkout', '-b', 'feature/preview'])
    await writeFile(join(repo, 'notes.md'), 'feature\n')
    git(repo, ['commit', '-am', 'feature change'])

    git(repo, ['checkout', baseBranch])
    await writeFile(join(repo, 'notes.md'), 'base advanced\n')
    git(repo, ['commit', '-am', 'advance base branch'])
    git(repo, ['checkout', 'feature/preview'])

    const repository = new GitManager().getWorktreeRepositoryForRoot(repo, new LocalGitHost())
    const content = await readReviewFileContent({
      repository,
      source: { type: 'branch', baseBranch },
      file: {
        path: 'notes.md',
        changeKind: 'modified',
        revision: 'test',
        additions: 1,
        deletions: 1,
        binary: false,
        conflicted: false
      },
      side: 'before'
    })

    expect(content).toMatchObject({
      status: 'text',
      text: 'base\n'
    })
  }, 30_000)

  it('reconstructs a completed-turn file only while its worktree after-version still matches', async () => {
    const { repo } = await createGitFixture()
    await writeFile(join(repo, 'src.ts'), 'const value = 1\nconst stable = true\n')
    git(repo, ['add', 'src.ts'])
    git(repo, ['commit', '-m', 'add source file'])
    await writeFile(join(repo, 'src.ts'), 'const value = 2\nconst stable = true\n')
    const diff = git(repo, ['diff', '--', 'src.ts'])
    const repository = new GitManager().getWorktreeRepositoryForRoot(repo, new LocalGitHost())

    await expect(
      readReviewTurnDiffFileContents({ repository, path: 'src.ts', diff })
    ).resolves.toEqual({
      status: 'text',
      before: 'const value = 1\nconst stable = true\n',
      after: 'const value = 2\nconst stable = true\n'
    })
    await expect(
      readReviewTurnDiffFileContents({
        repository,
        path: 'src.ts',
        diff: diff.slice(diff.indexOf('@@'))
      })
    ).resolves.toMatchObject({ status: 'text' })

    await writeFile(join(repo, 'src.ts'), 'const value = 3\nconst stable = true\n')
    await expect(
      readReviewTurnDiffFileContents({ repository, path: 'src.ts', diff })
    ).resolves.toMatchObject({ status: 'unsupported' })
  }, 30_000)
})
