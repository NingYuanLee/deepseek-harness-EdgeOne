import { deflateRawSync } from 'node:zlib'

export interface DocxParagraph {
  text: string
  heading?: 1 | 2 | 3
}

export interface DocxTable {
  headers?: string[]
  rows: string[][]
}

export interface DocxDocument {
  title?: string
  paragraphs?: Array<string | DocxParagraph>
  tables?: DocxTable[]
}

export interface XlsxSheet {
  name?: string
  rows: Array<Array<string | number | boolean | null | undefined>>
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[]
}

export interface PptxSlide {
  title?: string
  bullets?: string[]
}

export interface PptxPresentation {
  slides: PptxSlide[]
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

export function zipOfficeFiles(files: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const raw = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : Buffer.from(file.data)
    const deflated = deflateRawSync(raw)
    const crc = crc32(raw)
    const local = Buffer.concat([
      Buffer.from('PK\u0003\u0004'),
      u16(20),
      u16(0x800),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      deflated,
    ])
    const central = Buffer.concat([
      Buffer.from('PK\u0001\u0002'),
      u16(20),
      u16(20),
      u16(0x800),
      u16(8),
      u16(0),
      u16(0),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ])
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const centralDirectory = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    Buffer.from('PK\u0005\u0006'),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ])
  return new Uint8Array(Buffer.concat([...locals, centralDirectory, eocd]))
}

function wordText(text: string): string {
  return `<w:t xml:space="preserve">${xmlEscape(text)}</w:t>`
}

function wordParagraph(text: string, heading?: 1 | 2 | 3): string {
  const size = heading === 1 ? 32 : heading === 2 ? 26 : heading === 3 ? 22 : 21
  const bold = heading ? '<w:b/>' : ''
  return `<w:p><w:r><w:rPr>${bold}<w:sz w:val="${String(size)}"/><w:szCs w:val="${String(size)}"/></w:rPr>${wordText(text)}</w:r></w:p>`
}

function wordCell(text: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${wordParagraph(text)}</w:tc>`
}

function wordTable(table: DocxTable): string {
  const rows = [
    ...(table.headers && table.headers.length > 0 ? [table.headers] : []),
    ...table.rows,
  ]
  const body = rows.map(row => `<w:tr>${row.map(cell => wordCell(String(cell ?? ''))).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders></w:tblPr>${body}</w:tbl>`
}

export function buildDocx(document: DocxDocument): Uint8Array {
  const blocks: string[] = []
  if (document.title?.trim()) blocks.push(wordParagraph(document.title.trim(), 1))
  for (const paragraph of document.paragraphs ?? []) {
    if (typeof paragraph === 'string') {
      if (paragraph.trim()) blocks.push(wordParagraph(paragraph))
      continue
    }
    if (paragraph.text.trim()) blocks.push(wordParagraph(paragraph.text, paragraph.heading))
  }
  for (const table of document.tables ?? []) {
    if ((table.headers?.length || 0) + table.rows.length > 0) blocks.push(wordTable(table))
  }
  if (blocks.length === 0) blocks.push(wordParagraph(''))
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body>${blocks.join('')}<w:sectPr/></w:body>`,
    '</w:document>',
  ].join('')
  return zipOfficeFiles([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    },
    {
      name: 'word/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>',
    },
    { name: 'word/document.xml', data: documentXml },
  ])
}

function columnName(index: number): string {
  let value = index
  let name = ''
  while (value >= 0) {
    name = String.fromCharCode((value % 26) + 65) + name
    value = Math.floor(value / 26) - 1
  }
  return name
}

function cellXml(value: string | number | boolean | null | undefined, ref: string): string {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${String(value)}</v></c>`
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? '1' : '0'}</v></c>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`
}

function sheetNameOf(name: string | undefined, index: number): string {
  const cleaned = (name || `Sheet${String(index + 1)}`).replace(/[:\\/?*[\]]/g, ' ').trim() || `Sheet${String(index + 1)}`
  return cleaned.slice(0, 31)
}

export function buildXlsx(workbook: XlsxWorkbook): Uint8Array {
  const sheets = (workbook.sheets || []).slice(0, 16)
  if (sheets.length === 0) throw new Error('xlsx requires at least one sheet.')
  const files: Array<{ name: string; data: string }> = [
    {
      name: '[Content_Types].xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ...sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
        '</Types>',
      ].join(''),
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        ...sheets.map((_, index) => `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`),
        '</Relationships>',
      ].join(''),
    },
    {
      name: 'xl/workbook.xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<sheets>',
        ...sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheetNameOf(sheet.name, index))}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`),
        '</sheets></workbook>',
      ].join(''),
    },
  ]
  for (const [index, sheet] of sheets.entries()) {
    const rows = (sheet.rows || []).slice(0, 2000)
    const rowXml = rows.map((row, rowIndex) => {
      const cells = (row || []).slice(0, 50).map((value, columnIndex) => (
        cellXml(value, `${columnName(columnIndex)}${String(rowIndex + 1)}`)
      )).join('')
      return `<row r="${String(rowIndex + 1)}">${cells}</row>`
    }).join('')
    files.push({
      name: `xl/worksheets/sheet${String(index + 1)}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
    })
  }
  return zipOfficeFiles(files)
}

const PPT_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

function pptTreeRoot(): string {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
}

function pptParagraph(text: string, size: number, bold = false, bullet = false): string {
  const bulletPr = bullet
    ? '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>'
    : '<a:pPr/>'
  return `<a:p>${bulletPr}<a:r><a:rPr lang="zh-CN" sz="${String(size)}"${bold ? ' b="1"' : ''} dirty="0"/><a:t>${xmlEscape(text)}</a:t></a:r></a:p>`
}

function pptShape(id: number, name: string, ph: string, x: number, y: number, cx: number, cy: number, paragraphs: string): string {
  return [
    '<p:sp>',
    `<p:nvSpPr><p:cNvPr id="${String(id)}" name="${xmlEscape(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>`,
    `<p:spPr><a:xfrm><a:off x="${String(x)}" y="${String(y)}"/><a:ext cx="${String(cx)}" cy="${String(cy)}"/></a:xfrm></p:spPr>`,
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`,
    '</p:sp>',
  ].join('')
}

function pptSlideXml(slide: PptxSlide): string {
  const title = slide.title?.trim() || ''
  const bullets = (slide.bullets || []).map(item => item.trim()).filter(Boolean).slice(0, 20)
  const titleXml = pptShape(2, 'Title', 'type="title"', 685800, 274638, 10820100, 1143000, title ? pptParagraph(title, 3200, true) : '<a:p><a:endParaRPr/></a:p>')
  const bodyXml = pptShape(
    3,
    'Content',
    'type="body" idx="1"',
    685800,
    1600200,
    10820100,
    4525963,
    bullets.length > 0
      ? bullets.map(item => pptParagraph(item, 1800, false, true)).join('')
      : '<a:p><a:endParaRPr/></a:p>',
  )
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<p:sld ${PPT_NS}>`,
    `<p:cSld><p:spTree>${pptTreeRoot()}${titleXml}${bodyXml}</p:spTree></p:cSld>`,
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>',
    '</p:sld>',
  ].join('')
}

const PPT_THEME = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'

const PPT_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${PPT_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${pptTreeRoot()}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`

const PPT_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${PPT_NS} type="titleAndContent" preserve="1"><p:cSld name="Title and Content"><p:spTree>${pptTreeRoot()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

export function buildPptx(presentation: PptxPresentation): Uint8Array {
  const slides = (presentation.slides || []).slice(0, 40)
  if (slides.length === 0) throw new Error('pptx requires at least one slide.')
  const files: Array<{ name: string; data: string }> = [
    {
      name: '[Content_Types].xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
        ...slides.map((_, index) => `<Override PartName="/ppt/slides/slide${String(index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
        '</Types>',
      ].join(''),
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
        ...slides.map((_, index) => `<Relationship Id="rId${String(index + 2)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${String(index + 1)}.xml"/>`),
        '</Relationships>',
      ].join(''),
    },
    {
      name: 'ppt/presentation.xml',
      data: [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>',
        '<p:sldIdLst>',
        ...slides.map((_, index) => `<p:sldId id="${String(256 + index)}" r:id="rId${String(index + 2)}"/>`),
        '</p:sldIdLst>',
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>',
        '</p:presentation>',
      ].join(''),
    },
    { name: 'ppt/theme/theme1.xml', data: PPT_THEME },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: PPT_MASTER },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>',
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: PPT_LAYOUT },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    },
  ]
  for (const [index, slide] of slides.entries()) {
    files.push({ name: `ppt/slides/slide${String(index + 1)}.xml`, data: pptSlideXml(slide) })
    files.push({
      name: `ppt/slides/_rels/slide${String(index + 1)}.xml.rels`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
    })
  }
  return zipOfficeFiles(files)
}

export function isOfficeDocumentPath(path: string): boolean {
  return /\.(docx|xlsx|pptx|ppt)$/i.test(path)
}
