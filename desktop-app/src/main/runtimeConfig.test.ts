import { describe, expect, it } from 'vitest'

import { loadDesktopRuntimeConfig } from './runtimeConfig'

describe('loadDesktopRuntimeConfig', () => {
  it('loads admin backend runtime config from process env shape', () => {
    expect(
      loadDesktopRuntimeConfig({
        ADMIN_BACKEND_URL: ' https://admin.example.com ',
        ADMIN_BACKEND_MODEL_USER_ID: ' user-1 ',
        ADMIN_BACKEND_MODEL_CACHE_TTL_MS: '5'
      })
    ).toEqual({
      adminBackendUrl: 'https://admin.example.com',
      adminBackendModelUserId: 'user-1',
      adminBackendModelCacheTtlMs: 5
    })
  })

  it('omits adminBackendUrl when ADMIN_BACKEND_URL is missing or blank', () => {
    expect(loadDesktopRuntimeConfig({})).toEqual({})
    expect(loadDesktopRuntimeConfig({ ADMIN_BACKEND_URL: '   ' })).toEqual({})
  })

  it('omits blank user ids and invalid cache TTL values', () => {
    expect(
      loadDesktopRuntimeConfig({
        ADMIN_BACKEND_URL: 'https://admin.example.com',
        ADMIN_BACKEND_MODEL_USER_ID: '   ',
        ADMIN_BACKEND_MODEL_CACHE_TTL_MS: 'not-a-number'
      })
    ).toEqual({
      adminBackendUrl: 'https://admin.example.com'
    })
  })

  it('loads the main-process-only remote Codex command', () => {
    expect(
      loadDesktopRuntimeConfig({
        DASCOWORK_REMOTE_CODEX_COMMAND: ' /opt/codex/bin/codex '
      })
    ).toEqual({ remoteCodexCommand: '/opt/codex/bin/codex' })
  })

  it('loads a main-owned integrated terminal command', () => {
    expect(loadDesktopRuntimeConfig({ DASCOWORK_TERMINAL_COMMAND: ' /bin/fish ' })).toEqual({
      terminalCommand: '/bin/fish'
    })
  })

  it('loads a complete, immutable primary runtime release descriptor', () => {
    expect(
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_VERSION: '2026.09.06',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'https://releases.example.test/runtime.zip',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'A'.repeat(64),
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
        DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://releases.example.test'
      })
    ).toMatchObject({
      primaryRuntimeRelease: {
        version: '2026.09.06',
        archiveUrl: 'https://releases.example.test/runtime.zip',
        archiveSha256: 'a'.repeat(64),
        archiveSizeBytes: 123,
        allowedOrigins: ['https://releases.example.test']
      }
    })
  })

  it('loads a signed primary runtime manifest descriptor without exposing signing keys', () => {
    expect(
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'https://releases.example.test/manifest.json',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS: 'https://releases.example.test',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL: 'stable'
      })
    ).toMatchObject({
      primaryRuntimeManifest: {
        manifestUrl: 'https://releases.example.test/manifest.json',
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable'
      }
    })
  })

  it('rejects incomplete and untrusted primary runtime release configuration', () => {
    expect(() =>
      loadDesktopRuntimeConfig({ DASCOWORK_PRIMARY_RUNTIME_VERSION: '2026.09.06' })
    ).toThrow('must provide version')
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_VERSION: '2026.09.06',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'http://releases.example.test/runtime.zip',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(64),
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
        DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://releases.example.test'
      })
    ).toThrow('must be an HTTPS URL')
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_VERSION: '2026.09.06',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'https://mirror.example.test/runtime.zip',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(64),
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
        DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://releases.example.test'
      })
    ).toThrow('not in the configured allowlist')
  })

  it('rejects incomplete, untrusted, and conflicting signed manifest configuration', () => {
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'https://releases.example.test/manifest.json'
      })
    ).toThrow('must provide')
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'http://releases.example.test/manifest.json',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS: 'https://releases.example.test',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL: 'stable'
      })
    ).toThrow('must be an HTTPS URL')
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_PRIMARY_RUNTIME_VERSION: '2026.09.06',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'https://releases.example.test/runtime.zip',
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(64),
        DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
        DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://releases.example.test',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'https://releases.example.test/manifest.json',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS: 'https://releases.example.test',
        DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL: 'stable'
      })
    ).toThrow('cannot be used together')
  })

  it('rejects multiline remote Codex commands', () => {
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_REMOTE_CODEX_COMMAND: 'codex\nwhoami'
      })
    ).toThrow('must be an executable name or absolute POSIX path')
  })

  it('rejects relative remote Codex paths', () => {
    expect(() =>
      loadDesktopRuntimeConfig({
        DASCOWORK_REMOTE_CODEX_COMMAND: './bin/codex'
      })
    ).toThrow('must be an executable name or absolute POSIX path')
  })

  it('rejects multiline terminal commands', () => {
    expect(() =>
      loadDesktopRuntimeConfig({ DASCOWORK_TERMINAL_COMMAND: 'zsh\necho unsafe' })
    ).toThrow('DASCOWORK_TERMINAL_COMMAND must be an executable name or absolute POSIX path')
  })
})
