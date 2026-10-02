import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { appRoot, cleanupTempDirs, e2eTempRoot } from './app'

export type AppServerRequestCapture = {
  environment: NodeJS.ProcessEnv
  requestParams: (method: string) => Promise<Array<Record<string, unknown>>>
  cleanup: () => Promise<void>
}

export async function createAppServerRequestCapture(): Promise<AppServerRequestCapture> {
  const directory = await mkdtemp(join(e2eTempRoot(), 'dsc-asp-capture-'))
  const pidPath = join(directory, 'app-server.pid')
  const requestLogPath = join(directory, 'requests.jsonl')
  await writeFile(requestLogPath, '', 'utf8')

  return {
    environment: {
      CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/app-server-process-wrapper.mjs'),
      DASCOWORK_E2E_APP_SERVER_PID_PATH: pidPath,
      DASCOWORK_E2E_APP_SERVER_REQUEST_LOG_PATH: requestLogPath
    },
    requestParams: async (method) => {
      const requests = await readAppServerRequests(requestLogPath)
      return requests.flatMap((request) =>
        request.method === method && isRecord(request.params) ? [request.params] : []
      )
    },
    cleanup: () => cleanupTempDirs([directory])
  }
}

async function readAppServerRequests(path: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(path, 'utf8')
  return contents.split('\n').flatMap((line) => {
    if (!line) return []
    try {
      const request = JSON.parse(line) as unknown
      return isRecord(request) ? [request] : []
    } catch {
      return []
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
