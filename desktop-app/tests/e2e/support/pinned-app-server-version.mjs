import { readFileSync } from 'node:fs'

const manifest = JSON.parse(
  readFileSync(
    new URL('../../../vendors/codex-app-server-client/protocol-manifest.json', import.meta.url),
    'utf8'
  )
)

export const pinnedAppServerVersion = manifest.supportedAppServerVersions[0]
