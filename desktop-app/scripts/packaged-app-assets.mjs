/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM helper uses runtime data structures. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readlink, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const receiptSchema = 'dascowork-packaged-app-assets.v1'

export async function writePackagedAppAssetReceipt({ root, output }) {
  const assetRoot = resolve(root)
  const entries = []
  await collectEntries(assetRoot, assetRoot, entries)
  const files = entries.filter((entry) => entry.type === 'file')
  if (files.length === 0) throw new Error('Packaged app asset root contains no files.')

  const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const receipt = {
    schemaVersion: receiptSchema,
    assetSha256: sha256Text(payload),
    entryCount: entries.length,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0)
  }
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(resolve(output), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  return receipt
}

async function collectEntries(root, directory, records) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort(compareNames)
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    const relativePath = entryPath
      .slice(root.length + (root.endsWith(sep) ? 0 : 1))
      .replaceAll(sep, '/')
    const metadata = await lstat(entryPath)
    const mode = metadata.mode & 0o777
    if (metadata.isDirectory()) {
      records.push({ type: 'directory', path: relativePath, mode })
      await collectEntries(root, entryPath, records)
      continue
    }
    if (metadata.isSymbolicLink()) {
      records.push({
        type: 'symlink',
        path: relativePath,
        mode,
        target: await readlink(entryPath)
      })
      continue
    }
    if (!metadata.isFile()) {
      throw new Error(`Packaged app asset tree contains an unsupported entry: ${relativePath}`)
    }
    records.push({
      type: 'file',
      path: relativePath,
      mode,
      size: metadata.size,
      sha256: await sha256File(entryPath)
    })
  }
}

function compareNames(left, right) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}
