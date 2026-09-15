import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import JSZip from 'jszip'

import { verifyLivePresentationArtifact } from '../verify-live-presentation-artifact.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const expectedPath = join(
  appRoot,
  'tests',
  'fixtures',
  'presentations',
  'ai-agent-security-market.expected.json'
)

test('validates an R07 PPTX against the HTML facts, slide graph, visual, and geometry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-presentation-artifact-'))
  try {
    const presentationPath = join(directory, 'r07-ai-agent-security-market.pptx')
    await writeFile(presentationPath, await createPresentation())

    const report = await verifyLivePresentationArtifact({
      inputPath: presentationPath,
      expectedPath
    })

    assert.equal(report.status, 'passed')
    assert.equal(report.slides.count, 6)
    assert.equal(report.slides.hasTable, true)
    assert.equal(report.slides.hasChart, true)
    assert.equal(report.slides.hasImage, true)
    assert.equal(report.slides.hasChineseFont, true)
    assert.equal(report.expected.factIds.length, 5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a PPTX that places a shape outside the declared slide bounds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-presentation-artifact-'))
  try {
    const presentationPath = join(directory, 'out-of-bounds.pptx')
    await writeFile(presentationPath, await createPresentation({ outOfBounds: true }))
    await assert.rejects(
      verifyLivePresentationArtifact({ inputPath: presentationPath, expectedPath }),
      /escapes the declared slide bounds/u
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a PPTX that provides a media file without a slide relationship', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-presentation-artifact-'))
  try {
    const presentationPath = join(directory, 'unlinked-media.pptx')
    await writeFile(
      presentationPath,
      await createPresentation({ includeVisualRelationship: false })
    )
    await assert.rejects(
      verifyLivePresentationArtifact({ inputPath: presentationPath, expectedPath }),
      /does not contain an image relationship/u
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Node test fixture uses JavaScript's inferred return value.
async function createPresentation({ outOfBounds = false, includeVisualRelationship = true } = {}) {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8'))
  const zip = new JSZip()
  const titles = expected.expectedPageTypes.map((pageType) => pageType.titleToken)
  const facts = expected.facts.map((fact) => fact.value)
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  )
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst>${titles.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${titles.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`
  )
  for (const [index, title] of titles.entries()) {
    const body = index === titles.length - 1 ? facts.join(' ') : ''
    const offsetX = outOfBounds && index === 0 ? '12191000' : '100000'
    const table =
      expected.expectedPageTypes[index].id === 'table'
        ? '<a:tbl><a:tr><a:tc/><a:tc/></a:tr><a:tr><a:tc/><a:tc/></a:tr></a:tbl>'
        : ''
    const chart =
      expected.expectedPageTypes[index].id === 'chart' ? '<c:chart r:id="rIdChart"></c:chart>' : ''
    const image =
      expected.expectedPageTypes[index].id === 'image'
        ? `<p:pic><p:nvPicPr><p:cNvPr descr="${expected.requiredImageAltText}"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>`
        : ''
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:spPr><a:xfrm><a:off x="${offsetX}" y="100000"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:rPr typeface="${expected.requiredChineseFont}"/><a:t>${title} ${body}</a:t></a:r></a:p></p:txBody></p:sp>${table}${chart}${image}</p:spTree></p:cSld></p:sld>`
    )
    if (expected.expectedPageTypes[index].id === 'chart') {
      zip.file(
        `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'
      )
    }
  }
  zip.file('ppt/media/chart.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  zip.file('ppt/charts/chart1.xml', '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')
  if (includeVisualRelationship) {
    zip.file(
      'ppt/slides/_rels/slide6.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/chart.png"/></Relationships>'
    )
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}
