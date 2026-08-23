export type ReferenceFileIconKind =
  | 'artifactDocument'
  | 'build'
  | 'code'
  | 'cplusplus'
  | 'css'
  | 'document'
  | 'file'
  | 'folder'
  | 'hashes'
  | 'html'
  | 'image'
  | 'java'
  | 'javascript'
  | 'json'
  | 'notebook'
  | 'pdf'
  | 'php'
  | 'presentation'
  | 'python'
  | 'react'
  | 'rust'
  | 'shell'
  | 'skill'
  | 'spreadsheet'
  | 'terminal'
  | 'toml'
  | 'typescript'
  | 'yaml'

const filenameIconKinds: Readonly<Record<string, ReferenceFileIconKind>> = {
  'skill.md': 'skill'
}

const extensionIconKinds: Readonly<Record<string, ReferenceFileIconKind>> = {
  ts: 'typescript',
  tsx: 'react',
  jsx: 'react',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  hs: 'javascript',
  py: 'python',
  java: 'java',
  rs: 'rust',
  php: 'php',
  css: 'css',
  scss: 'css',
  less: 'css',
  sass: 'css',
  cpp: 'cplusplus',
  cxx: 'cplusplus',
  cc: 'cplusplus',
  c: 'cplusplus',
  hpp: 'cplusplus',
  hh: 'cplusplus',
  h: 'cplusplus',
  rb: 'code',
  go: 'code',
  kt: 'code',
  swift: 'code',
  m: 'code',
  mm: 'code',
  cs: 'code',
  sql: 'code',
  json: 'json',
  jsonc: 'json',
  md: 'document',
  mdx: 'document',
  markdown: 'document',
  mkd: 'document',
  mdown: 'document',
  txt: 'document',
  text: 'document',
  log: 'document',
  cfg: 'document',
  conf: 'document',
  ini: 'document',
  html: 'html',
  htm: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'document',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  xls: 'spreadsheet',
  xlsm: 'spreadsheet',
  xlsx: 'spreadsheet',
  doc: 'artifactDocument',
  docx: 'artifactDocument',
  ipynb: 'notebook',
  ppt: 'presentation',
  pptx: 'presentation',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  dockerfile: 'terminal',
  env: 'document',
  dotenv: 'document',
  gitignore: 'document',
  lock: 'document',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'image',
  ico: 'image',
  build: 'build',
  bazel: 'build',
  bzl: 'build',
  ninja: 'build',
  gradle: 'build',
  mk: 'build',
  makefile: 'build',
  sha: 'hashes',
  sha1: 'hashes',
  sha256: 'hashes',
  md5: 'hashes',
  checksum: 'hashes',
  sum: 'hashes',
  pdf: 'pdf',
  zip: 'folder',
  gz: 'folder',
  tgz: 'folder',
  tar: 'folder'
}

/** Classifies a reference using the file-name artwork used by resource cards. */
export function resourceFileIconKind(
  path: string | undefined,
  mimeType: string | undefined
): ReferenceFileIconKind {
  if (path && /[\\/]$/.test(path)) return 'folder'

  const name = path?.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? ''
  const fileNameKind = filenameIconKinds[name]
  if (fileNameKind) return fileNameKind

  const extension = name.includes('.') ? name.split('.').at(-1) : name || undefined
  const extensionKind = extension ? extensionIconKinds[extension] : undefined
  if (extensionKind) return extensionKind

  const normalizedMimeType = mimeType?.toLowerCase()
  if (normalizedMimeType?.startsWith('image/')) return 'image'
  if (normalizedMimeType?.startsWith('text/')) return 'document'
  if (normalizedMimeType?.startsWith('application/pdf')) return 'pdf'
  if (
    normalizedMimeType?.startsWith('application/zip') ||
    normalizedMimeType?.startsWith('application/gzip')
  ) {
    return 'folder'
  }
  return 'file'
}
