import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { PresentationParseError, parsePresentationBytes } from './presentationParser'

describe('parsePresentationBytes', () => {
  it('builds stable slide and object ids from a minimal Chinese PPTX', async () => {
    const result = await parsePresentationBytes(await basicPptx())

    expect(result.document).toMatchObject({ width: 12_192_000, height: 6_858_000 })
    expect(result.document.slides).toHaveLength(1)
    expect(result.document.slides[0]).toMatchObject({ id: '256', number: 1 })
    expect(result.document.slides[0]?.elements).toContainEqual(
      expect.objectContaining({
        id: '256:2',
        kind: 'text',
        name: '标题',
        text: '你好，Artifact',
        hyperlink: 'https://example.com/docs',
        frame: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 }
      })
    )
  })

  it('rejects malformed and suspiciously compressed archives before rendering', async () => {
    await expect(parsePresentationBytes(new Uint8Array([1, 2, 3]).buffer)).rejects.toBeInstanceOf(
      PresentationParseError
    )

    const bomb = new JSZip()
    bomb.file('ppt/presentation.xml', 'a'.repeat(1024 * 1024))
    const bytes = await bomb.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
    await expect(parsePresentationBytes(bytes)).rejects.toThrow('压缩比异常')
  })
})

async function basicPptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
      <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:sldSz cx="12192000" cy="6858000"/>
        <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      </p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    </Relationships>`
  )
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <p:cSld><p:spTree>
        <p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"><a:hlinkClick r:id="rIdLink"/></p:cNvPr></p:nvSpPr>
          <p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="1371600"/></a:xfrm><a:solidFill><a:srgbClr val="336699"/></a:solidFill></p:spPr>
          <p:txBody><a:p><a:r><a:t>你好，Artifact</a:t></a:r></a:p></p:txBody>
        </p:sp>
      </p:spTree></p:cSld>
    </p:sld>`
  )
  zip.file(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/>
    </Relationships>`
  )
  return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
}
