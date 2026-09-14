import { describe, expect, test } from 'vitest'
import { FONT, MONO_EM, PAGE, ascii, buildPdf, line, monoRight, monoWidth, text } from './pdf'

// A PDF cannot be opened here to look at, so it is checked structurally
// instead — and the check that matters most is the xref table. Every offset in
// it must land exactly on its object header; a single byte of drift makes the
// file unopenable with no diagnostic, which is the failure mode this whole
// suite exists to catch.

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Reads the xref back the way a reader would: from startxref, by offset. */
function parseXref(pdf: string): { offsets: number[]; size: number; startxref: number } {
  const startxref = Number(/startxref\s+(\d+)/.exec(pdf)?.[1])
  const size = Number(/\/Size (\d+)/.exec(pdf)?.[1])

  const table = pdf.slice(startxref)
  const header = /^xref\n0 (\d+)\n/.exec(table)
  expect(header, 'startxref must point at the xref keyword').not.toBeNull()

  const entries = table.slice(header![0].length)
  const offsets: number[] = []
  // Entry zero is the free-list head and is skipped.
  for (let i = 1; i < Number(header![1]); i++) {
    const entry = entries.slice(i * 20, i * 20 + 20)
    expect(entry, `entry ${i} must be 20 bytes`).toHaveLength(20)
    expect(entry.endsWith('n \n')).toBe(true)
    offsets.push(Number(entry.slice(0, 10)))
  }
  return { offsets, size, startxref }
}

const page = (n: number) => text(40, 800, 10, FONT.mono, `page ${n}`)

describe('the file envelope', () => {
  test('opens and closes the way a reader expects', () => {
    const pdf = decode(buildPdf([page(1)]))
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true)
    expect(pdf.endsWith('%%EOF\n')).toBe(true)
  })

  test('is entirely ASCII, which is what makes the offsets valid', () => {
    const bytes = buildPdf([page(1)])
    expect(bytes.every((b) => b <= 0x7e)).toBe(true)
  })

  test('refuses to emit a file whose offsets it knows are wrong', () => {
    // The guard exists because a stray non-ASCII character shifts every byte
    // offset after it, and the resulting file fails to open with no clue why.
    // ascii() normally prevents this; the check is the backstop.
    expect(() => buildPdf(['BT /F1 10 Tf 40 800 Td <FEFF> Tj ET\nЗ'])).toThrow(/non-ASCII/)
  })

  test('needs at least one page', () => {
    expect(() => buildPdf([])).toThrow(/at least one page/)
  })
})

describe('the xref table', () => {
  test('every offset lands on its own object header', () => {
    const pdf = decode(buildPdf([page(1), page(2)]))
    const { offsets } = parseXref(pdf)

    offsets.forEach((offset, i) => {
      expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`).toBe(true)
    })
  })

  test('holds one entry per object plus the free head', () => {
    const pdf = decode(buildPdf([page(1), page(2), page(3)]))
    const { offsets, size } = parseXref(pdf)
    // 1 catalog + 1 page tree + 3 pages + 3 streams + 4 fonts.
    expect(offsets).toHaveLength(12)
    expect(size).toBe(13)
  })

  test('offsets ascend, as a reader that scans them assumes', () => {
    const { offsets } = parseXref(decode(buildPdf([page(1), page(2)])))
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!)
    }
  })

  test('startxref points past the last object', () => {
    const pdf = decode(buildPdf([page(1)]))
    const { offsets, startxref } = parseXref(pdf)
    expect(startxref).toBeGreaterThan(offsets[offsets.length - 1]!)
  })
})

describe('the document structure', () => {
  test('the page tree counts what it lists', () => {
    const pdf = decode(buildPdf([page(1), page(2), page(3)]))
    const kids = /\/Kids \[([^\]]*)\]/.exec(pdf)?.[1] ?? ''
    expect(kids.match(/\d+ 0 R/g)).toHaveLength(3)
    expect(pdf).toContain('/Count 3')
  })

  test('every stream declares its own length exactly', () => {
    // Overstate it and readers run past the end; understate it and the content
    // is silently truncated.
    const content = page(1)
    const pdf = decode(buildPdf([content]))
    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(pdf)?.[1])
    const body = pdf.slice(pdf.indexOf('stream\n') + 'stream\n'.length, pdf.indexOf('\nendstream'))
    expect(declared).toBe(content.length)
    expect(body).toHaveLength(declared)
  })

  test('offers the four standard fonts and embeds none of them', () => {
    const pdf = decode(buildPdf([page(1)]))
    for (const base of ['Helvetica', 'Helvetica-Bold', 'Courier', 'Courier-Bold']) {
      expect(pdf).toContain(`/BaseFont /${base}`)
    }
    // Embedding is what a font file would need, and there is no font file.
    expect(pdf).not.toContain('/FontFile')
  })

  test('every page is A4', () => {
    const pdf = decode(buildPdf([page(1)]))
    expect(pdf).toContain(`/MediaBox [0 0 ${PAGE.width} ${PAGE.height}]`)
  })
})

describe('ascii', () => {
  test('leaves printable ASCII alone', () => {
    expect(ascii('Goal 2450 -> +170 (P/F/C)')).toBe('Goal 2450 -> +170 (P/F/C)')
  })

  test('replaces what the standard fonts cannot draw', () => {
    // The whole reason the report is in English.
    expect(ascii('Цель')).toBe('????')
    expect(ascii('café')).toBe('caf?')
    expect(ascii('a\nb')).toBe('a?b')
  })
})

describe('text placement', () => {
  test('escapes the three characters a PDF string cannot hold raw', () => {
    const drawn = text(0, 0, 10, FONT.mono, 'a(b)c\\d')
    expect(drawn).toContain('(a\\(b\\)c\\\\d)')
  })

  test('right-alignment uses Courier fixed advance', () => {
    expect(monoWidth('12345', 10)).toBe(5 * MONO_EM * 10)
    // A five-character number ending at x=100 starts at 100 − 30.
    expect(monoRight(100, 700, 10, FONT.mono, '12345')).toContain('70 700 Td')
  })

  test('longer numbers start further left, so their right edges align', () => {
    const short = /(-?[\d.]+) 700 Td/.exec(monoRight(200, 700, 8, FONT.mono, '99'))?.[1]
    const long = /(-?[\d.]+) 700 Td/.exec(monoRight(200, 700, 8, FONT.mono, '12345'))?.[1]
    expect(Number(long)).toBeLessThan(Number(short))
  })

  test('draws a rule as a stroked path', () => {
    expect(line(40, 100, 555, 100)).toContain('40 100 m 555 100 l S')
  })
})
