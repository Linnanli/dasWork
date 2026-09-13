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
  path: relativePathSchema,
  entryRequired: z.boolean().optional()
})

const binaryManifestSchema = z.object({
  name: z.string().min(1),
  path: relativePathSchema,
  required: z.boolean().optional()
})

const fontManifestSchema = z.object({
  name: z.string().min(1),
  path: relativePathSchema
})

const bundledPluginManifestSchema = z.object({
  marketplace: z.string().min(1),
  path: relativePathSchema
})

const bundledSkillManifestSchema = z.object({
  path: relativePathSchema.refine(
    (value) => value.endsWith('/SKILL.md') || value === 'SKILL.md',
    'bundled skill path must identify SKILL.md'
  ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
})

const sourceDigestSchema = z.object({
  path: relativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
})

const syntheticTestOnlySchema = z
  .object({
    kind: z.literal('dascowork-primary-runtime-synthetic-test.v1'),
    requiredNodePackage: z.literal('@dascowork/test-artifact-tool')
  })
  .strict()

const genericManifestFields = {
  bundleVersion: z.string().min(1),
  target: z.object({
    platform: z.custom<NodeJS.Platform>((value) => typeof value === 'string'),
    arch: z.custom<NodeJS.Architecture>((value) => typeof value === 'string')
  }),
  node: z.object({
    path: relativePathSchema,
    version: z.string().min(1).optional()
  }),
  nodePackages: z.array(packageManifestSchema).min(1),
  python: z
    .object({
      path: relativePathSchema,
      version: z.string().min(1).optional(),
      packages: z.array(packageManifestSchema).optional()
    })
    .optional(),
  binaries: z.array(binaryManifestSchema).optional(),
  fonts: z.array(fontManifestSchema).optional(),
  bundledPlugins: z.array(bundledPluginManifestSchema).optional(),
  bundledSkills: z.array(bundledSkillManifestSchema).optional(),
  skillsToRemove: z.array(relativePathSchema).optional(),
  sourceDigests: z.array(sourceDigestSchema).optional(),
  syntheticTestOnly: syntheticTestOnlySchema.optional()
}

const primaryRuntimeManifestV1Schema = z
  .object({ bundleFormatVersion: z.literal(1), ...genericManifestFields })
  .strict()

const primaryRuntimeManifestV2Schema = z
  .object({ bundleFormatVersion: z.literal(2), ...genericManifestFields })
  .strict()

/**
 * Legacy v2 cache decoder. This is intentionally read-only: production feeds
 * emit the generic v2 schema above, and diagnostics mark this form so update
 * selection can replace it without exposing its package identity as a new
 * Runtime capability.
 */
const legacyPrimaryRuntimeManifestV2Schema = z
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
      legacyV2: true,
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
  primaryRuntimeManifestV2Schema,
  legacyPrimaryRuntimeManifestV2Schema
])

export async function readPrimaryRuntimeManifest(path: string): Promise<PrimaryRuntimeManifest> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  return parsePrimaryRuntimeManifest(raw)
}

export function parsePrimaryRuntimeManifest(input: unknown): PrimaryRuntimeManifest {
  return primaryRuntimeManifestSchema.parse(input)
}
