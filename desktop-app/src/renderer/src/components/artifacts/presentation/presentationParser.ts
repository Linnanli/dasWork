import { XMLParser, XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'

import type {
  PresentationElement,
  PresentationFrame,
  PresentationParseResult,
  PresentationSlide
} from './presentationTypes'

const MAX_ZIP_ENTRIES = 2_000
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
const MAX_ENTRY_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 100
const DEFAULT_SLIDE_WIDTH = 12_192_000
const DEFAULT_SLIDE_HEIGHT = 6_858_000

type XmlNode = {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

export class PresentationParseError extends Error {}

/**
 * Parses only the safe, read-only OOXML subset needed by the host panel. The
 * central directory is inspected before JSZip inflates data. XML parsing stays
 * inside the Worker and has no DOM or external-resource dependency.
 */
export async function parsePresentationBytes(bytes: ArrayBuffer): Promise<PresentationParseResult> {
  validateZipDirectory(bytes)
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  const presentation = parseXml(await requiredText(zip, 'ppt/presentation.xml'), '演示文稿结构')
  const relationshipMap = relationshipTargets(
    await requiredText(zip, 'ppt/_rels/presentation.xml.rels'),
    'ppt/presentation.xml'
  )
  const size = slideSize(presentation)
  const slideRefs = children(descendants(presentation, 'sldIdLst')[0], 'sldId')
    .map((node, index) => ({
      id: attribute(node, 'id') || `slide-${index + 1}`,
      relationshipId: attribute(node, 'r:id')
    }))
    .filter((slide): slide is { id: string; relationshipId: string } =>
      Boolean(slide.relationshipId)
    )
  if (!slideRefs.length) throw new PresentationParseError('该 PPTX 不包含可显示的幻灯片。')

  const warnings: string[] = []
  const slides: PresentationSlide[] = []
  for (const [index, slideRef] of slideRefs.entries()) {
    const slidePath = relationshipMap.get(slideRef.relationshipId)
    if (!slidePath || !slidePath.startsWith('ppt/slides/')) {
      throw new PresentationParseError('PPTX 幻灯片关系无效。')
    }
    slides.push(await parseSlide(zip, slidePath, slideRef.id, index + 1, size, warnings))
  }
  return { document: { ...size, slides }, warnings }
}

function validateZipDirectory(bytes: ArrayBuffer): void {
  const view = new DataView(bytes)
  if (view.byteLength < 22) throw new PresentationParseError('文件不是有效的 PPTX 压缩包。')
  const eocdOffset = findEndOfCentralDirectory(view)
  if (eocdOffset < 0) throw new PresentationParseError('文件不是有效的 PPTX 压缩包。')
  const disk = view.getUint16(eocdOffset + 4, true)
  const centralDisk = view.getUint16(eocdOffset + 6, true)
  const entries = view.getUint16(eocdOffset + 10, true)
  const centralSize = view.getUint32(eocdOffset + 12, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (disk !== 0 || centralDisk !== 0 || entries > MAX_ZIP_ENTRIES) {
    throw new PresentationParseError('PPTX 压缩包结构不受支持或条目过多。')
  }
  if (centralOffset + centralSize > view.byteLength)
    throw new PresentationParseError('PPTX 中央目录损坏。')

  let offset = centralOffset
  let totalUncompressed = 0
  const decoder = new TextDecoder()
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new PresentationParseError('PPTX 中央目录损坏。')
    }
    const compressed = view.getUint32(offset + 20, true)
    const uncompressed = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > view.byteLength || uncompressed > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new PresentationParseError('PPTX 包含过大的压缩条目。')
    }
    totalUncompressed += uncompressed
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new PresentationParseError('PPTX 解压后的内容过大。')
    }
    if (compressed === 0 ? uncompressed > 0 : uncompressed / compressed > MAX_COMPRESSION_RATIO) {
      throw new PresentationParseError('PPTX 压缩比异常，已拒绝解析。')
    }
    const name = decoder.decode(new Uint8Array(bytes, offset + 46, nameLength))
    if (!name || name.includes('\0') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new PresentationParseError('PPTX 包含不安全的压缩条目路径。')
    }
    offset = nextOffset
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - 65_557)
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset
  }
  return -1
}

async function parseSlide(
  zip: JSZip,
  path: string,
  id: string,
  number: number,
  size: { width: number; height: number },
  warnings: string[]
): Promise<PresentationSlide> {
  const slide = parseXml(await requiredText(zip, path), `第 ${number} 张幻灯片`)
  const relationshipsPath = path.replace(/([^/]+)$/u, '_rels/$1.rels')
  const relationships = zip.file(relationshipsPath)
    ? relationshipTargets(await requiredText(zip, relationshipsPath), path)
    : new Map<string, string>()
  const tree = descendants(slide, 'spTree')[0]
  const elements = tree
    ? await parseShapeChildren(zip, tree, id, size, relationships, warnings)
    : []
  return { id, number, name: `第 ${number} 张`, elements }
}

async function parseShapeChildren(
  zip: JSZip,
  parent: XmlNode,
  slideId: string,
  size: { width: number; height: number },
  relationships: ReadonlyMap<string, string>,
  warnings: string[]
): Promise<PresentationElement[]> {
  const output: PresentationElement[] = []
  for (const node of parent.children) {
    if (is(node, 'sp') || is(node, 'pic') || is(node, 'graphicFrame')) {
      const element = await parseElement(zip, node, slideId, size, relationships, warnings)
      if (element) output.push(element)
    } else if (is(node, 'grpSp')) {
      output.push(...(await parseShapeChildren(zip, node, slideId, size, relationships, warnings)))
    }
  }
  return output
}

async function parseElement(
  zip: JSZip,
  node: XmlNode,
  slideId: string,
  size: { width: number; height: number },
  relationships: ReadonlyMap<string, string>,
  warnings: string[]
): Promise<PresentationElement | undefined> {
  const nonVisual = descendants(node, 'cNvPr')[0]
  const sourceId = attribute(nonVisual, 'id')
  if (!sourceId) return undefined
  const name = attribute(nonVisual, 'name') || `对象 ${sourceId}`
  const frame = frameFor(node, size)
  const id = `${slideId}:${sourceId}`
  const hyperlink = hyperlinkFor(nonVisual, relationships)

  if (is(node, 'pic')) {
    const embedId = attribute(descendants(node, 'blip')[0], 'r:embed')
    const imagePath = embedId ? relationships.get(embedId) : undefined
    const image = imagePath ? zip.file(imagePath) : null
    if (!image) {
      warnings.push(`无法读取图片“${name}”。`)
      return { id, kind: 'image', name, frame, hyperlink }
    }
    return {
      id,
      kind: 'image',
      name,
      frame,
      imageDataUrl: `data:${mediaTypeFor(imagePath!)};base64,${await image.async('base64')}`,
      hyperlink
    }
  }
  if (is(node, 'graphicFrame')) {
    const table = descendants(node, 'tbl')[0]
    return table
      ? { id, kind: 'table', name, frame, text: textContent(table), hyperlink }
      : {
          id,
          kind: 'chart',
          name,
          frame,
          text: descendants(node, 'chart').length ? '图表' : '嵌入对象',
          hyperlink
        }
  }
  const text = textContent(node)
  return {
    id,
    kind: text ? 'text' : 'shape',
    name,
    frame,
    text: text || undefined,
    fill: colorFor(descendants(node, 'solidFill')[0]),
    color: colorFor(descendants(node, 'rPr')[0]),
    hyperlink
  }
}

function frameFor(node: XmlNode, size: { width: number; height: number }): PresentationFrame {
  const transform = descendants(node, 'xfrm')[0]
  const off = children(transform, 'off')[0]
  const ext = children(transform, 'ext')[0]
  return {
    x: clamp(numberAttribute(off, 'x') / size.width),
    y: clamp(numberAttribute(off, 'y') / size.height),
    width: clamp(numberAttribute(ext, 'cx') / size.width),
    height: clamp(numberAttribute(ext, 'cy') / size.height)
  }
}

function slideSize(document: XmlNode): { width: number; height: number } {
  const value = descendants(document, 'sldSz')[0]
  return {
    width: positiveNumber(attribute(value, 'cx')) ?? DEFAULT_SLIDE_WIDTH,
    height: positiveNumber(attribute(value, 'cy')) ?? DEFAULT_SLIDE_HEIGHT
  }
}

function relationshipTargets(xml: string, sourcePath: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const relationship of descendants(parseXml(xml, '关系表'), 'Relationship')) {
    const id = attribute(relationship, 'Id')
    const target = attribute(relationship, 'Target')
    if (!id || !target) continue
    if (attribute(relationship, 'TargetMode') === 'External') {
      if (/^https?:\/\//iu.test(target)) result.set(id, target)
      continue
    }
    const resolved = resolveRelationshipPath(sourcePath, target)
    if (resolved) result.set(id, resolved)
  }
  return result
}

function resolveRelationshipPath(sourcePath: string, target: string): string | undefined {
  if (target.includes('\\') || target.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target))
    return undefined
  const output = sourcePath.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') output.pop()
    else output.push(segment)
  }
  const resolved = output.join('/')
  return resolved.startsWith('ppt/') ? resolved : undefined
}

function hyperlinkFor(
  node: XmlNode | undefined,
  relationships: ReadonlyMap<string, string>
): string | undefined {
  const click = descendants(node, 'hlinkClick')[0]
  const target = click ? relationships.get(attribute(click, 'r:id') || '') : undefined
  return target && /^https?:\/\//iu.test(target) ? target : undefined
}

function textContent(node: XmlNode): string {
  return descendants(node, 't')
    .map((value) => value.text.trim())
    .filter(Boolean)
    .join('\n')
}

function colorFor(node: XmlNode | undefined): string | undefined {
  const rgb = attribute(descendants(node, 'srgbClr')[0], 'val')
  return rgb && /^[A-Fa-f0-9]{6}$/u.test(rgb) ? `#${rgb}` : undefined
}

function mediaTypeFor(path: string): string {
  switch (path.split('.').at(-1)?.toLocaleLowerCase()) {
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'webp':
      return 'image/webp'
    default:
      return 'image/jpeg'
  }
}

function parseXml(xml: string, subject: string): XmlNode {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false, unpairedTags: [] })
  if (validation !== true) throw new PresentationParseError(`${subject} XML 损坏。`)
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    trimValues: false
  }).parse(xml) as Record<string, unknown>
  const [name, value] = Object.entries(parsed).find(([key]) => !key.startsWith('?')) ?? []
  if (!name) throw new PresentationParseError(`${subject} XML 损坏。`)
  return nodeFromValue(name, value)
}

function nodeFromValue(name: string, value: unknown): XmlNode {
  const attributes: Record<string, string> = {}
  const children: XmlNode[] = []
  let text = ''
  if (typeof value === 'string' || typeof value === 'number') text = String(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('@_')) attributes[key.slice(2)] = String(nested)
      else if (key === '#text') text += String(nested)
      else
        for (const item of Array.isArray(nested) ? nested : [nested])
          children.push(nodeFromValue(key, item))
    }
  }
  return { name, attributes, children, text }
}

function descendants(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return []
  const output: XmlNode[] = []
  for (const child of node.children) {
    if (is(child, name)) output.push(child)
    output.push(...descendants(child, name))
  }
  return output
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((child) => is(child, name)) ?? []
}

function is(node: XmlNode, localName: string): boolean {
  return node.name.split(':').at(-1) === localName
}

function attribute(node: XmlNode | undefined, name: string): string | undefined {
  return node?.attributes[name]
}

function numberAttribute(node: XmlNode | undefined, name: string): number {
  return positiveNumber(attribute(node, name)) ?? 0
}

function positiveNumber(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}

async function requiredText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path)
  if (!entry) throw new PresentationParseError(`PPTX 缺少必要文件：${path}`)
  return entry.async('text')
}
