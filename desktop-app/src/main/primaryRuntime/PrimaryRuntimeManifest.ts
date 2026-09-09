import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { z } from 'zod'

import type { PrimaryRuntimeManifest } from './primaryRuntimeTypes'

export const PRIMARY_RUNTIME_MANIFEST_FILENAME = 'runtime.json'

const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value), 'path must be relative')
  .refine((value) => !value.split(/[\\/]+/u).includes('..'), 'path must not traverse upward')

const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  path: relativePathSchema
})

const binaryManifestSchema = z.object({
  name: z.string().min(1),
  path: relativePathSchema,
  required: z.boolean().optional()
})

const primaryRuntimeManifestV1Schema = z
  .object({
    bundleFormatVersion: z.literal(1),
    bundleVersion: z.string().min(1),
    target: z.object({
      platform: z.custom<NodeJS.Platform>((value) => typeof value === 'string'),
      arch: z.custom<NodeJS.Architecture>((value) => typeof value === 'string')
    }),
    node: z.object({
      path: relativePathSchema,
      version: z.string().min(1).optional()
    }),
    nodePackages: z.array(packageManifestSchema),
    python: z
      .object({
        path: relativePathSchema,
        version: z.string().min(1).optional(),
        packages: z.array(packageManifestSchema).optional()
      })
      .optional(),
    binaries: z.array(binaryManifestSchema).optional(),
    bundledPlugins: z
      .array(
        z.object({
          marketplace: z.string().min(1),
          path: relativePathSchema
        })
      )
      .optional()
  })
  .strict()

const primaryRuntimeManifestV2Schema = z
  .object({
    artifactToolVersion: z.string().min(1),
    bundleFormatVersion: z.literal(2),
    bundleVersion: z.string().min(1),
    bundledPlugins: z.array(relativePathSchema).optional(),
    nodeVersion: z.string().min(1),
    pythonVersion: z.string().min(1).optional(),
    targetArch: z.custom<NodeJS.Architecture>((value) => typeof value === 'string'),
    targetPlatform: z.custom<NodeJS.Platform>((value) => typeof value === 'string'),
    nativeDependencies: z.array(z.string().min(1)).optional()
  })
  .passthrough()
  .transform(
    (manifest): PrimaryRuntimeManifest => ({
      bundleFormatVersion: manifest.bundleFormatVersion,
      bundleVersion: manifest.bundleVersion,
      target: {
        platform: manifest.targetPlatform,
        arch: manifest.targetArch
      },
      node: {
        path: 'dependencies/node/bin/node',
        version: manifest.nodeVersion
      },
      nodePackages: [
        {
          name: '@oai/artifact-tool',
          version: manifest.artifactToolVersion,
          path: 'dependencies/node/node_modules/@oai/artifact-tool'
        }
      ],
      ...(manifest.pythonVersion
        ? {
            python: {
              path: 'dependencies/python/bin/python',
              version: manifest.pythonVersion,
              packages: [
                {
                  name: 'python-runtime',
                  version: manifest.pythonVersion,
                  path: 'dependencies/python'
                }
              ]
            }
          }
        : {}),
      binaries: [
        { name: 'git', path: 'dependencies/bin/fallback/git' },
        { name: 'pnpm', path: 'dependencies/bin/fallback/pnpm' },
        { name: 'pdfinfo', path: 'dependencies/bin/override/pdfinfo' },
        { name: 'pdftoppm', path: 'dependencies/bin/override/pdftoppm' },
        { name: 'soffice', path: 'dependencies/bin/override/soffice' }
      ],
      bundledPlugins: (manifest.bundledPlugins ?? []).map((path) => ({
        marketplace: path.split('/').pop() ?? path,
        path
      }))
    })
  )

export const primaryRuntimeManifestSchema = z.union([
  primaryRuntimeManifestV1Schema,
  primaryRuntimeManifestV2Schema
])

export async function readPrimaryRuntimeManifest(path: string): Promise<PrimaryRuntimeManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  return parsePrimaryRuntimeManifest(raw)
}

export function parsePrimaryRuntimeManifest(input: unknown): PrimaryRuntimeManifest {
  return primaryRuntimeManifestSchema.parse(input)
}
