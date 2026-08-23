export function normalizeBrowserUrl(input: string): string | undefined {
  const value = input.trim()
  if (!value) return undefined
  const url = value.includes('://') ? value : `https://${value}`
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : undefined
  } catch {
    return undefined
  }
}
