export function cleanSkillMarkdown(contents: string, title: string): string {
  const withoutFrontmatter = contents.replace(/^---\s*[\r\n][\s\S]*?[\r\n]---\s*(?:[\r\n]|$)/u, '')
  const lines = withoutFrontmatter.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstContentIndex === -1) return ''

  const firstLine = lines[firstContentIndex].trim()
  if (firstLine.startsWith('# ')) {
    const heading = firstLine.replace(/^#\s+/u, '').trim()
    if (normalizeHeading(heading) === normalizeHeading(title)) {
      lines.splice(firstContentIndex, 1)
    }
  }
  return lines.join('\n').trim()
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ')
}
