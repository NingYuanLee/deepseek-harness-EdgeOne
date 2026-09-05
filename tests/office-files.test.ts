import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import test from 'node:test'
import { buildDocx, buildPptx, buildXlsx, isOfficeDocumentPath } from '../agents/_office-files.ts'

function unzipEntries(zip: Uint8Array): Map<string, string> {
  const buf = Buffer.from(zip)
  const entries = new Map<string, string>()
  let offset = 0
  while (offset + 30 <= buf.length) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break
    const method = buf.readUInt16LE(offset + 8)
    const compressed = buf.readUInt32LE(offset + 18)
    const nameLen = buf.readUInt16LE(offset + 26)
    const extraLen = buf.readUInt16LE(offset + 28)
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8')
    const start = offset + 30 + nameLen + extraLen
    const data = buf.subarray(start, start + compressed)
    const raw = method === 8 ? inflateRawSync(data) : data
    entries.set(name, raw.toString('utf8'))
    offset = start + compressed
  }
  return entries
}

test('office path detection covers Word, Excel, and PowerPoint', () => {
  assert.equal(isOfficeDocumentPath('notes/报告.docx'), true)
  assert.equal(isOfficeDocumentPath('data.xlsx'), true)
  assert.equal(isOfficeDocumentPath('deck.PPTX'), true)
  assert.equal(isOfficeDocumentPath('legacy.ppt'), true)
  assert.equal(isOfficeDocumentPath('readme.md'), false)
})

test('docx is a ZIP with Chinese text Word can parse', () => {
  const bytes = buildDocx({
    title: '季度报告',
    paragraphs: ['正文中文'],
    tables: [{ headers: ['列'], rows: [['值']] }],
  })
  assert.equal(bytes[0], 0x50)
  assert.equal(bytes[1], 0x4b)
  const entries = unzipEntries(bytes)
  assert.match(entries.get('word/document.xml') || '', /季度报告/)
  assert.match(entries.get('word/document.xml') || '', /正文中文/)
})

test('xlsx is a ZIP with Chinese cells Excel can parse', () => {
  const bytes = buildXlsx({
    sheets: [{ name: '销售:表', rows: [['品名', 12], ['中文', true]] }],
  })
  assert.equal(bytes[0], 0x50)
  const entries = unzipEntries(bytes)
  assert.match(entries.get('xl/workbook.xml') || '', /销售 表/)
  assert.match(entries.get('xl/worksheets/sheet1.xml') || '', /中文/)
})

test('pptx is a ZIP with Chinese slides PowerPoint can parse', () => {
  const bytes = buildPptx({
    slides: [
      { title: '项目汇报', bullets: ['进展', '风险'] },
      { title: '下一步' },
    ],
  })
  assert.equal(bytes[0], 0x50)
  const entries = unzipEntries(bytes)
  assert.match(entries.get('ppt/slides/slide1.xml') || '', /项目汇报/)
  assert.match(entries.get('ppt/slides/slide1.xml') || '', /进展/)
  assert.match(entries.get('ppt/presentation.xml') || '', /sldId/)
  assert.ok(entries.has('ppt/theme/theme1.xml'))
})

test('office builders reject empty workbooks and decks', () => {
  assert.throws(() => buildXlsx({ sheets: [] }), /at least one sheet/)
  assert.throws(() => buildPptx({ slides: [] }), /at least one slide/)
})
