export type InlineReferenceKind =
  | 'agent'
  | 'app'
  | 'conversation'
  | 'external-url'
  | 'local-file'
  | 'local-folder'
  | 'mcp-resource'
  | 'plugin'
  | 'sites-project'
  | 'skill'
  | 'unsupported'

type LocalInlineReference = {
  href: string
  kind: 'local-file' | 'local-folder'
  label: string
  line?: number
  path: string
  tooltip: string
}

type SemanticInlineReference = {
  href: string
  kind: Exclude<InlineReferenceKind, 'local-file' | 'local-folder' | 'unsupported'>
  label: string
  targetId?: string
  tooltip: string
}

type UnsupportedInlineReference = {
  href: string
  kind: 'unsupported'
  label: string
  tooltip: string
}

export type InlineReferenceDescriptor =
  | LocalInlineReference
  | SemanticInlineReference
  | UnsupportedInlineReference

export type ReferenceInlineTargetInput = {
  href?: string
  inlineText?: string
  label?: string
}

export type ParsedLocalReference = {
  kind: 'local-file' | 'local-folder'
  line?: number
  path: string
}

/**
 * Classifies the Markdown link forms emitted by Codex's conversation renderer.
 * The custom URI branches mirror the reference `DQ()` classifier; this stays a
 * renderer-only representation and is never sent back to the app server.
 */
export function classifyReferenceTarget(
  input: ReferenceInlineTargetInput
): InlineReferenceDescriptor | undefined {
  const href = input.href?.trim()
  const label = input.label?.trim() || input.inlineText?.trim() || href || ''

  if (!href) {
    return label.startsWith('$') && label.length > 1
      ? semanticReference('skill', label, label)
      : undefined
  }

  if (hasMalformedEncoding(href)) return unsupportedReference(href, label)

  // Keep the ordering of the reference classifier: semantic mentions win over
  // filesystem heuristics (for example, a `$skill` label linked to a path).
  if (href.startsWith('app://') && hasIdentifier(href, 'app://')) {
    return semanticReference('app', href, label, identifierFrom(href, 'app://'))
  }
  if (href.startsWith('plugin://') && hasIdentifier(href, 'plugin://')) {
    return semanticReference('plugin', href, label, identifierFrom(href, 'plugin://'))
  }
  if (href.startsWith('agent://') && hasIdentifier(href, 'agent://')) {
    return semanticReference('agent', href, label, identifierFrom(href, 'agent://'))
  }
  if (href.startsWith('subagent://') && hasIdentifier(href, 'subagent://')) {
    return semanticReference('agent', href, label, identifierFrom(href, 'subagent://'))
  }
  if (href.startsWith('thread://') && hasIdentifier(href, 'thread://')) {
    return semanticReference('conversation', href, label, identifierFrom(href, 'thread://'))
  }
  if (href.startsWith('chatgpt-conversation://')) {
    const targetId = decodeUriIdentifier(href, 'chatgpt-conversation://')
    return targetId
      ? semanticReference('conversation', href, label, targetId)
      : unsupportedReference(href, label)
  }
  if (href.startsWith('mcp-resource://')) {
    return parseMcpResourceTarget(href)
      ? semanticReference('mcp-resource', href, label)
      : unsupportedReference(href, label)
  }
  if (href.startsWith('sites-project://')) {
    const targetId = decodeUriIdentifier(href, 'sites-project://')
    return targetId
      ? semanticReference('sites-project', href, label, targetId)
      : unsupportedReference(href, label)
  }
  if (label.startsWith('$') && label.length > 1) return semanticReference('skill', href, label)

  const externalUrl = safeHttpUrl(href)
  if (externalUrl) return semanticReference('external-url', externalUrl, label)

  const localReference = parseLocalReferenceTarget(href)
  if (localReference) {
    return {
      href,
      label,
      tooltip: localReference.pathWithLine ?? href,
      ...localReference
    }
  }

  if (href.startsWith('#')) return undefined
  return unsupportedReference(href, label)
}

export function parseLocalReferenceTarget(value: string):
  | (ParsedLocalReference & {
      pathWithLine: string
    })
  | undefined {
  const trimmed = value.trim()
  if (!trimmed || hasMalformedEncoding(trimmed)) return undefined

  let path: string
  if (trimmed.startsWith('file://')) {
    try {
      const url = new URL(trimmed)
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost'))
        return undefined
      path = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//u.test(path)) path = path.slice(1).replaceAll('/', '\\')
    } catch {
      return undefined
    }
  } else {
    if (!isAbsoluteLocalPath(trimmed) && hasUrlScheme(trimmed)) return undefined
    const withoutQueryOrHash = trimmed.split(/[?#]/u, 1)[0] ?? ''
    try {
      path = decodeURIComponent(withoutQueryOrHash)
    } catch {
      return undefined
    }
  }

  if (!isSafeLocalPath(path)) return undefined
  const { path: pathWithoutLine, line } = splitLineNumber(path)
  if (!isSafeLocalPath(pathWithoutLine)) return undefined
  return {
    kind: /[\\/]$/u.test(pathWithoutLine) ? 'local-folder' : 'local-file',
    path: pathWithoutLine,
    ...(line ? { line } : {}),
    pathWithLine: line ? `${pathWithoutLine}:${line}` : pathWithoutLine
  }
}

export function isSafeRelativeReferencePath(path: string): boolean {
  if (!path || isAbsoluteLocalPath(path) || path.includes('\0') || path.startsWith('\\'))
    return false
  return !path
    .replaceAll('\\', '/')
    .split('/')
    .some((segment) => segment === '..')
}

export function isAbsoluteLocalPath(path: string): boolean {
  return (path.startsWith('/') && !path.startsWith('//')) || /^[A-Za-z]:[\\/]/u.test(path)
}

export function referenceUrlTransform(url: string): string | null | undefined {
  const reference = classifyReferenceTarget({ href: url })
  if (reference?.kind === 'unsupported') return null
  return url
}

function semanticReference(
  kind: SemanticInlineReference['kind'],
  href: string,
  label: string,
  targetId?: string
): SemanticInlineReference {
  return { kind, href, label, tooltip: href, ...(targetId ? { targetId } : {}) }
}

function unsupportedReference(href: string, label: string): UnsupportedInlineReference {
  return { kind: 'unsupported', href, label, tooltip: href }
}

function parseMcpResourceTarget(value: string): boolean {
  const encoded = value.slice('mcp-resource://'.length)
  const separator = encoded.indexOf('/')
  if (separator <= 0 || separator === encoded.length - 1) return false
  try {
    return Boolean(
      decodeURIComponent(encoded.slice(0, separator)).trim() &&
      decodeURIComponent(encoded.slice(separator + 1)).trim()
    )
  } catch {
    return false
  }
}

function decodeUriIdentifier(value: string, prefix: string): string | undefined {
  try {
    const identifier = decodeURIComponent(value.slice(prefix.length)).trim()
    return identifier || undefined
  } catch {
    return undefined
  }
}

function identifierFrom(value: string, prefix: string): string | undefined {
  const identifier = value.slice(prefix.length).trim()
  return identifier || undefined
}

function hasIdentifier(value: string, prefix: string): boolean {
  return Boolean(identifierFrom(value, prefix))
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function splitLineNumber(path: string): { path: string; line?: number } {
  const match = path.match(/^(.*):(\d+)$/u)
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined
  return { path: match?.[1] ?? path, ...(line && line > 0 ? { line } : {}) }
}

function isSafeLocalPath(path: string): boolean {
  if (!path || path.includes('\0')) return false
  if (!isAbsoluteLocalPath(path) && !isSafeRelativeReferencePath(path)) return false
  return true
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/iu.test(value)
}

function hasMalformedEncoding(value: string): boolean {
  try {
    decodeURIComponent(value)
    return false
  } catch {
    return true
  }
}
