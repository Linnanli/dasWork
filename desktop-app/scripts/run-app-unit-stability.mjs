#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const targetFile = 'src/renderer/src/App.test.tsx'
const targetName = 'renders every completed command and wait item in a historical commentary replay'
// These single-file checks use one process-isolated worker. A full round starts
// the unit project and each existing local-Git file in fresh processes: Vitest 4
// can exhaust its per-file fork lifecycle before it boots the last local-Git
// worker. This preserves every test's fork isolation, deadline, scenario,
// assertion, retry, and skip while retaining child-process MCP/Pipe semantics.
const singleFileWorkerArgs = ['--pool=forks', '--no-file-parallelism', '--maxWorkers=1']
const unitProjectWorkerArgs = ['--pool=forks', '--maxWorkers=2']
const localGitProjectWorkerArgs = ['--pool=forks', '--no-file-parallelism', '--maxWorkers=1']
const localGitTestFiles = [
  'src/main/localGit/GitManager.integration.test.ts',
  'src/main/localGit/LocalBranchService.test.ts',
  'src/main/localGit/LocalCommitService.test.ts',
  'src/main/localGit/LocalPushService.test.ts',
  'src/main/localGit/LocalGitService.integration.test.ts',
  'src/main/localGit/LocalGitService.test.ts',
  'src/main/localGit/reviewSnapshot.test.ts'
]

const checks = [
  {
    label: 'historical commentary replay',
    repetitions: 50,
    args: ['run', targetFile, '--testNamePattern', targetName, '--reporter=dot'],
    workerArgs: singleFileWorkerArgs
  },
  {
    label: 'App.test.tsx',
    repetitions: 10,
    args: ['run', targetFile, '--reporter=dot'],
    workerArgs: singleFileWorkerArgs
  },
  {
    label: 'full unit suite',
    repetitions: 3,
    commands: [
      {
        label: 'unit project',
        args: ['run', '--project=unit', '--reporter=dot'],
        workerArgs: unitProjectWorkerArgs
      },
      ...localGitTestFiles.map((testFile) => ({
        label: `local-Git integration: ${testFile}`,
        args: ['run', testFile, '--project=local-git-integration', '--reporter=dot'],
        workerArgs: localGitProjectWorkerArgs
      }))
    ]
  }
]

for (const check of checks) {
  const durations = []
  for (let attempt = 1; attempt <= check.repetitions; attempt += 1) {
    const startedAt = performance.now()
    const commands = check.commands ?? [check]
    const failedCommand = commands.find((command) => {
      const result = spawnSync(
        process.execPath,
        ['node_modules/vitest/vitest.mjs', ...command.args, ...command.workerArgs],
        {
          cwd: appRoot,
          env: process.env,
          stdio: 'inherit'
        }
      )
      return result.status !== 0
    })
    const durationMs = Math.round(performance.now() - startedAt)
    durations.push(durationMs)
    if (failedCommand) {
      throw new Error(
        `${check.label} (${failedCommand.label ?? 'test command'}) failed on repetition ${attempt}/${check.repetitions} after ${durationMs}ms.`
      )
    }
  }
  console.log(
    JSON.stringify({
      check: check.label,
      repetitions: check.repetitions,
      minDurationMs: Math.min(...durations),
      maxDurationMs: Math.max(...durations),
      averageDurationMs: Math.round(
        durations.reduce((total, value) => total + value, 0) / durations.length
      )
    })
  )
}
