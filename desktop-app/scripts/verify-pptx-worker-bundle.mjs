import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const assetsDirectory = resolve(import.meta.dirname, '..', 'out', 'renderer', 'assets')
if (!existsSync(assetsDirectory)) {
  throw new Error('The production renderer bundle is missing its assets directory.')
}

const workerFile = readdirSync(assetsDirectory).find((file) =>
  /^presentation\.worker-[A-Za-z0-9_-]+\.js$/u.test(file)
)
if (!workerFile) {
  throw new Error('The production renderer bundle is missing the local PPTX parser Worker asset.')
}

const workerSource = readFileSync(resolve(assetsDirectory, workerFile), 'utf8')
if (!workerSource.includes('PPTX') || !workerSource.includes('JSZip')) {
  throw new Error('The local PPTX parser Worker asset is incomplete.')
}

console.log(`Verified local PPTX parser Worker asset: ${workerFile}`)
