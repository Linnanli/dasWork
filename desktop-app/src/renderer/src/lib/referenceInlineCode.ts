import { classifyReferenceTarget, type InlineReferenceDescriptor } from './referenceInlineTarget'

export function inlineCodeReference(content: string): InlineReferenceDescriptor | undefined {
  const trimmed = content.trim()
  if (!trimmed) return undefined

  if (trimmed.startsWith('@')) {
    const reference = classifyReferenceTarget({
      href: trimmed.slice(1),
      inlineText: trimmed.slice(1)
    })
    return reference?.kind === 'local-file' || reference?.kind === 'local-folder'
      ? reference
      : undefined
  }

  const markdownLink = parseInlineMarkdownLink(trimmed)
  if (markdownLink) {
    const reference = classifyReferenceTarget(markdownLink)
    return reference?.kind === 'unsupported' ? undefined : reference
  }

  return trimmed.startsWith('$') ? classifyReferenceTarget({ inlineText: trimmed }) : undefined
}

function parseInlineMarkdownLink(value: string): { href: string; label: string } | undefined {
  const match = value.match(/^\[((?:\\.|[^\]\n])+)\]\(((?:\\.|[^)\n])+)\)$/u)
  if (!match) return undefined
  const label = unescapeMarkdown(match[1] ?? '').trim()
  const href = unescapeMarkdown(match[2] ?? '').trim()
  return label && href ? { label, href } : undefined
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\(.)/gu, '$1')
}
