#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This executable validates an untrusted PPTX artifact at its file boundary. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

const expectedSchema = 'dascowork-r07-presentations-expected.v2'
const reportSchema = 'dascowork-live-presentation-artifact-report.v1'
const requiredParts = [
  '[Content_Types].xml',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels'
]

/**
 * Verifies the observable PPTX boundary used by R07. It deliberately does not
 * trust a model-produced receipt: the artifact is opened as an OOXML package,
 * its slide graph and geometry are checked, and source facts are matched again.
 */
export async function verifyLivePresentationArtifact({ inputPath, expectedPath }) {
  const [pptx, expected] = await Promise.all([readFile(inputPath), readExpected(expectedPath)])
  const inputFixture = await readInputFixture(expectedPath, expected)
  for (const fact of expected.facts) {
    assert(inputFixture.includes(fact.value), `Input HTML fixture is missing fact ${fact.id}.`)
  }
  const archive = await JSZip.loadAsync(pptx)
  for (const part of requiredParts) {
    assert(archive.file(part), `Generated PPTX is missing ${part}.`)
  }

  const [presentationXml, relationshipXml] = await Promise.all([
    requiredText(archive, 'ppt/presentation.xml'),
    requiredText(archive, 'ppt/_rels/presentation.xml.rels')
  ])
  const slideSize = readSlideSize(presentationXml)
  const slideTargets = readPresentationSlideTargets(presentationXml, relationshipXml)
  const slidePaths = Object.keys(archive.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort(compareSlidePaths)

  assert(slidePaths.length >= expected.expectedPageTypes.length, 'PPTX does not contain six slides.')
  assert(slideTargets.length === slidePaths.length, 'PPTX slide relationships do not match slide files.')
  assert(
    new Set(slideTargets).size === slideTargets.length,
    'PPTX presentation relationships contain a duplicate slide target.'
  )
  for (const target of slideTargets) {
    assert(archive.file(target), `PPTX presentation references a missing slide: ${target}`)
  }
  for (const slidePath of slidePaths) {
    assert(slideTargets.includes(slidePath), `PPTX slide is missing from the presentation: ${slidePath}`)
  }

  const slideXml = await Promise.all(slidePaths.map((path) => requiredText(archive, path)))
  const slideText = slideXml.map(extractText)
  const presentationText = slideText.join('\n')
  assertDistinctTitleSlides(slideText, expected.expectedPageTypes)
  for (const fact of expected.facts) {
    assert(presentationText.includes(fact.value), `PPTX is missing input fact ${fact.id}.`)
  }

  const geometry = slideXml.flatMap((xml, index) =>
    readSlideGeometry(xml, slidePaths[index], slideSize)
  )
  assert(geometry.length > 0, 'PPTX does not contain inspectable slide geometry.')
  const hasTable = hasTableStructure(slideXml)
  const hasChart = await hasChartRelationship(archive, slidePaths, slideXml)
  const hasImage = await hasImageRelationshipAndAltText(
    archive,
    slidePaths,
    slideXml,
    expected.requiredImageAltText
  )
  const hasChineseFont = slideXml.some((xml) =>
    xml.includes(`typeface="${expected.requiredChineseFont}"`)
  )
  assert(hasTable, 'PPTX does not contain a table with at least two rows and columns.')
  assert(hasChart, 'PPTX does not contain a chart relationship.')
  assert(hasImage, 'PPTX does not contain an image relationship with the required alt text.')
  assert(
    hasChineseFont,
    `PPTX does not declare the required Chinese font: ${expected.requiredChineseFont}`
  )

  return {
    schemaVersion: reportSchema,
    status: 'passed',
    validationScope: 'OOXML structure, source facts, slide graph, and in-bounds geometry',
    artifact: {
      filename: basename(inputPath),
      sha256: createHash('sha256').update(pptx).digest('hex'),
      byteCount: pptx.byteLength
    },
    slides: {
      count: slidePaths.length,
      paths: slidePaths,
      sizeEmu: slideSize,
      inspectedGeometryCount: geometry.length,
      hasTable,
      hasChart,
      hasImage,
      hasChineseFont
    },
    expected: {
      pageTypes: expected.expectedPageTypes.map((pageType) => pageType.id),
      factIds: expected.facts.map((fact) => fact.id)
    }
  }
}

async function readExpected(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== expectedSchema ||
    typeof parsed.inputFile !== 'string' ||
    basename(parsed.inputFile) !== parsed.inputFile ||
    !/^[a-z0-9][a-z0-9.-]*\.html$/u.test(parsed.inputFile) ||
    typeof parsed.outputFile !== 'string' ||
    !Array.isArray(parsed.expectedPageTypes) ||
    parsed.expectedPageTypes.length !== 6 ||
    !hasExpectedPageTypes(parsed.expectedPageTypes) ||
    typeof parsed.requiredChineseFont !== 'string' ||
    parsed.requiredChineseFont.length === 0 ||
    typeof parsed.requiredImageAltText !== 'string' ||
    parsed.requiredImageAltText.length === 0 ||
    !Array.isArray(parsed.facts) ||
    parsed.facts.length < 4 ||
    !parsed.facts.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.id === 'string' &&
        fact.id.length > 0 &&
        typeof fact.value === 'string' &&
        fact.value.length > 0
    )
  ) {
    throw new Error('Live presentation expected-data fixture has an invalid schema.')
  }
  return parsed
}

async function readInputFixture(expectedPath, expected) {
  return readFile(join(dirname(expectedPath), expected.inputFile), 'utf8')
}

function hasExpectedPageTypes(value) {
  const expectedIds = ['cover', 'agenda', 'summary', 'table', 'chart', 'image']
  return (
    value.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.titleToken === 'string' &&
        entry.titleToken.length > 0
    ) &&
    [...value.map((entry) => entry.id)].sort().join(',') === expectedIds.sort().join(',')
  )
}

async function requiredText(archive, path) {
  const entry = archive.file(path)
  assert(entry, `PPTX is missing ${path}.`)
  return entry.async('string')
}

function readSlideSize(presentationXml) {
  const tag = presentationXml.match(/<p:sldSz\b[^>]*>/u)?.[0]
  const cx = readPositiveIntegerAttribute(tag, 'cx')
  const cy = readPositiveIntegerAttribute(tag, 'cy')
  assert(cx && cy, 'PPTX presentation does not declare a valid slide size.')
  return { cx, cy }
}

function readPresentationSlideTargets(presentationXml, relationshipsXml) {
  const declaredIds = [...presentationXml.matchAll(/<p:sldId\b[^>]*>/gu)].map((match) =>
    readAttribute(match[0], 'r:id')
  )
  assert(
    declaredIds.length > 0 && declaredIds.every((id) => typeof id === 'string' && id.length > 0),
    'PPTX presentation does not declare valid slide IDs.'
  )
  assert(
    new Set(declaredIds).size === declaredIds.length,
    'PPTX presentation contains duplicate slide IDs.'
  )
  const targetsById = new Map()
  for (const relationship of relationshipsXml.matchAll(/<Relationship\b[^>]*>/gu)) {
    const tag = relationship[0]
    const id = readAttribute(tag, 'Id')
    const type = readAttribute(tag, 'Type')
    const target = readAttribute(tag, 'Target')
    if (!type?.endsWith('/slide') || !target) continue
    assert(id, 'PPTX slide relationship has no ID.')
    assert(
      /^slides\/slide\d+\.xml$/u.test(target),
      `PPTX presentation contains an unsafe slide relationship target: ${target}`
    )
    assert(!targetsById.has(id), `PPTX presentation contains duplicate relationship ID: ${id}`)
    targetsById.set(id, join('ppt', target).replaceAll('\\', '/'))
  }
  assert(targetsById.size > 0, 'PPTX presentation does not reference any slides.')
  assert(
    declaredIds.every((id) => targetsById.has(id)) && declaredIds.length === targetsById.size,
    'PPTX declared slides and slide relationships do not match.'
  )
  return declaredIds.map((id) => targetsById.get(id))
}

function readSlideGeometry(xml, slidePath, slideSize) {
  const geometry = []
  for (const transform of xml.matchAll(/<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/gu)) {
    const body = transform[1]
    const offset = body.match(/<a:off\b[^>]*\/>/u)?.[0]
    const extent = body.match(/<a:ext\b[^>]*\/>/u)?.[0]
    if (!offset || !extent) continue
    const x = readNonNegativeIntegerAttribute(offset, 'x')
    const y = readNonNegativeIntegerAttribute(offset, 'y')
    const cx = readNonNegativeIntegerAttribute(extent, 'cx')
    const cy = readNonNegativeIntegerAttribute(extent, 'cy')
    // PptxGenJS writes the root p:spTree group with a zero-sized child
    // coordinate space. It is OOXML scaffolding rather than a drawable shape,
    // so accept that exact form without allowing zero-sized drawings.
    const isZeroSizedGroupCoordinateSpace =
      cx === 0 &&
      cy === 0 &&
      /<a:chOff\b[^>]*\/>/u.test(body) &&
      /<a:chExt\b[^>]*\/>/u.test(body)
    if (isZeroSizedGroupCoordinateSpace) {
      assert(
        x !== undefined && y !== undefined,
        `PPTX has invalid group coordinate geometry in ${slidePath}.`
      )
      continue
    }
    assert(
      x !== undefined && y !== undefined && cx && cy,
      `PPTX has invalid drawing geometry in ${slidePath}.`
    )
    assert(
      x + cx <= slideSize.cx && y + cy <= slideSize.cy,
      `PPTX drawing escapes the declared slide bounds in ${slidePath}.`
    )
    geometry.push({ slidePath, x, y, cx, cy })
  }
  return geometry
}

function assertDistinctTitleSlides(slideText, pageTypes) {
  const candidates = pageTypes.map((pageType) => {
    const matches = slideText.flatMap((text, index) => (text.includes(pageType.titleToken) ? [index] : []))
    assert(matches.length > 0, `PPTX does not contain the required page title: ${pageType.titleToken}`)
    return matches
  })
  assert(assignDistinctSlides(candidates), 'One slide cannot substitute for multiple required page types.')
}

function assignDistinctSlides(candidates, index = 0, assigned = new Set()) {
  if (index === candidates.length) return true
  return candidates[index].some((slide) => {
    if (assigned.has(slide)) return false
    assigned.add(slide)
    const matches = assignDistinctSlides(candidates, index + 1, assigned)
    assigned.delete(slide)
    return matches
  })
}

function hasTableStructure(slideXml) {
  return slideXml.some((xml) => {
    const table = xml.match(/<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/u)?.[1]
    if (!table) return false
    const rows = [...table.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gu)]
    return rows.length >= 2 && rows.some((row) => (row[1].match(/<a:tc\b/gu) ?? []).length >= 2)
  })
}

async function hasChartRelationship(archive, slidePaths, slideXml) {
  for (let index = 0; index < slideXml.length; index += 1) {
    const slideName = basename(slidePaths[index])
    const relationshipPath = `ppt/slides/_rels/${slideName}.rels`
    const relationship = archive.file(relationshipPath)
    if (!relationship) continue
    const relationshipXml = await relationship.async('string')
    const chartRelationshipIds = [...slideXml[index].matchAll(/<c:chart\b[^>]*>/gu)]
      .map((match) => readAttribute(match[0], 'r:id'))
      .filter((id) => typeof id === 'string' && id.length > 0)
    for (const relationshipId of chartRelationshipIds) {
      if (hasRelatedPart(archive, relationshipXml, relationshipId, '/chart', '../charts/')) return true
    }
  }
  return false
}

async function hasImageRelationshipAndAltText(archive, slidePaths, slideXml, requiredAltText) {
  for (let index = 0; index < slideXml.length; index += 1) {
    const slideName = basename(slidePaths[index])
    const relationship = archive.file(`ppt/slides/_rels/${slideName}.rels`)
    if (!relationship) continue
    const relationshipXml = await relationship.async('string')
    const imageRelationshipIds = [
      ...slideXml[index].matchAll(/<a:blip\b[^>]*\br:embed="([^"]+)"[^>]*>/gu)
    ].map((match) => match[1])
    const hasImage = imageRelationshipIds.some((relationshipId) =>
      hasRelatedPart(archive, relationshipXml, relationshipId, '/image', '../media/')
    )
    const hasAltText = [...slideXml[index].matchAll(/<p:cNvPr\b[^>]*>/gu)].some(
      (match) => readAttribute(match[0], 'descr') === requiredAltText
    )
    if (hasImage && hasAltText) return true
  }
  return false
}

function hasRelatedPart(archive, relationshipsXml, relationshipId, requiredTypeSuffix, requiredTargetPrefix) {
  const relationship = [...relationshipsXml.matchAll(/<Relationship\b[^>]*>/gu)].find(
    (match) => readAttribute(match[0], 'Id') === relationshipId
  )?.[0]
  const type = relationship ? readAttribute(relationship, 'Type') : undefined
  const target = relationship ? readAttribute(relationship, 'Target') : undefined
  const partPath = target ? resolveRelatedPartPath(target, requiredTargetPrefix) : undefined
  return Boolean(
    type?.endsWith(requiredTypeSuffix) &&
      partPath &&
      archive.file(partPath)
  )
}

function resolveRelatedPartPath(target, relativeTargetPrefix) {
  const relativeDirectory = relativeTargetPrefix.replace(/^\.\.\//u, '')
  const absoluteTargetPrefix = `/ppt/${relativeDirectory}`
  const filename = target.startsWith(relativeTargetPrefix)
    ? target.slice(relativeTargetPrefix.length)
    : target.startsWith(absoluteTargetPrefix)
      ? target.slice(absoluteTargetPrefix.length)
      : undefined
  if (!filename || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(filename)) return undefined
  return `ppt/${relativeDirectory}${filename}`
}

function extractText(xml) {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gu)]
    .map((match) => decodeXml(match[1]))
    .join('')
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

function readAttribute(tag, attribute) {
  if (!tag) return undefined
  return tag.match(new RegExp(`\\b${attribute}="([^"]*)"`, 'u'))?.[1]
}

function readNonNegativeIntegerAttribute(tag, attribute) {
  const value = readAttribute(tag, attribute)
  if (!value || !/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function readPositiveIntegerAttribute(tag, attribute) {
  const parsed = readNonNegativeIntegerAttribute(tag, attribute)
  return parsed && parsed > 0 ? parsed : undefined
}

function compareSlidePaths(left, right) {
  const leftNumber = Number(left.match(/slide(\d+)\.xml$/u)?.[1])
  const rightNumber = Number(right.match(/slide(\d+)\.xml$/u)?.[1])
  return leftNumber - rightNumber
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await verifyLivePresentationArtifact(options)
  if (options.reportPath) await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
    index += 1
    if (argument === '--input') options.inputPath = resolve(value)
    else if (argument === '--expected') options.expectedPath = resolve(value)
    else if (argument === '--report') options.reportPath = resolve(value)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.inputPath || !options.expectedPath) {
    throw new Error('Usage: verify-live-presentation-artifact.mjs --input <pptx> --expected <expected.json> [--report <json>]')
  }
  if (options.reportPath && dirname(options.reportPath) === options.reportPath) {
    throw new Error('Live presentation report must be a file path.')
  }
  return options
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main()
}
