// A minimal PDF writer: enough for a multi-page table of text and rules, and
// nothing else.
//
// Hand-written rather than pulled in as a dependency because the alternative
// costs about half a megabyte in the bundle — a PDF library plus a Cyrillic
// font to embed — and the build already warns about chunk size. The price is
// that the report is in English: the fourteen fonts every PDF reader has built
// in carry no Cyrillic glyphs at all, and there is no encoding trick that adds
// them. That trade is deliberate and it is why every string here goes through
// ascii().

/** A4 in points, which is what PDF measures in. */
export const PAGE = { width: 595, height: 842 } as const

/**
 * The four standard fonts this writer offers. All are built into every reader,
 * so nothing is embedded.
 *
 * Courier earns its place: every glyph is exactly 0.6 em wide, so a column of
 * numbers can be right-aligned with arithmetic instead of a width table. The
 * proportional fonts are only ever used left-aligned, which needs no widths.
 */
export const FONT = {
  sans: 'F1',
  sansBold: 'F2',
  mono: 'F3',
  monoBold: 'F4',
} as const

export type FontName = (typeof FONT)[keyof typeof FONT]

const BASE_FONTS = ['Helvetica', 'Helvetica-Bold', 'Courier', 'Courier-Bold'] as const

/** Courier's fixed advance width, in em. */
export const MONO_EM = 0.6

export function monoWidth(text: string, size: number): number {
  return text.length * MONO_EM * size
}

/**
 * Everything outside printable ASCII becomes '?'.
 *
 * Two reasons, and both matter. The standard fonts cannot draw those
 * characters, so they would come out as garbage; and byte offsets in the xref
 * table are computed from string length, which only equals the byte count while
 * every character is one UTF-8 byte. A stray Cyrillic label would corrupt the
 * file, not just look wrong.
 */
export function ascii(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    out += code >= 0x20 && code <= 0x7e ? ch : '?'
  }
  return out
}

/** PDF string literals escape exactly these three. */
function literal(text: string): string {
  return ascii(text).replace(/[\\()]/g, '\\$&')
}

const round = (n: number) => Math.round(n * 100) / 100

/** Left-aligned text. The only form the proportional fonts are used in. */
export function text(x: number, y: number, size: number, font: FontName, s: string): string {
  return `BT /${font} ${size} Tf ${round(x)} ${round(y)} Td (${literal(s)}) Tj ET\n`
}

/** Right-aligned text. Monospace only — see FONT. */
export function monoRight(
  right: number,
  y: number,
  size: number,
  font: 'F3' | 'F4',
  s: string,
): string {
  return text(right - monoWidth(ascii(s), size), y, size, font, s)
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width = 0.5,
  gray = 0.8,
): string {
  return `${round(gray)} G ${round(width)} w ${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S\n`
}

export type Rgb = readonly [number, number, number]

/**
 * A filled rectangle — the row tints behind the table.
 *
 * Wrapped in q/Q because `rg` sets the fill colour for everything after it, and
 * text is filled too: without the save/restore, the first tinted row would turn
 * every subsequent glyph on the page that colour.
 */
export function fillRect(x: number, y: number, w: number, h: number, [r, g, b]: Rgb): string {
  const c = `${round(r)} ${round(g)} ${round(b)}`
  return `q ${c} rg ${round(x)} ${round(y)} ${round(w)} ${round(h)} re f Q\n`
}

/**
 * Assembles the file.
 *
 * Object numbering is positional and has to stay that way: the catalog is 1,
 * the page tree 2, then one Page per content stream, then the streams, then the
 * fonts. The xref table records the byte offset of each `N 0 obj`, which is why
 * the whole document is built as one ASCII string and measured with .length.
 */
export function buildPdf(contents: readonly string[]): Uint8Array {
  if (contents.length === 0) throw new Error('a PDF needs at least one page')

  const pageCount = contents.length
  const firstPage = 3
  const firstContent = firstPage + pageCount
  const firstFont = firstContent + pageCount

  const fontResource = `<< ${BASE_FONTS.map((_, i) => `/F${i + 1} ${firstFont + i} 0 R`).join(' ')} >>`

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${contents.map((_, i) => `${firstPage + i} 0 R`).join(' ')}] /Count ${pageCount} >>`,
    ...contents.map(
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}]` +
        ` /Resources << /Font ${fontResource} >> /Contents ${firstContent + i} 0 R >>`,
    ),
    ...contents.map((c) => `<< /Length ${c.length} >>\nstream\n${c}\nendstream`),
    ...BASE_FONTS.map(
      (base) => `<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`,
    ),
  ]

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const startxref = out.length
  const size = objects.length + 1
  // Every entry is exactly 20 bytes; readers seek by multiplying, so a single
  // character off here breaks the whole file.
  out += `xref\n0 ${size}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`

  // Loud rather than corrupt: a non-ASCII byte would make every offset above
  // wrong, and the file would fail to open with no clue why.
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) > 0x7e) {
      throw new Error(`non-ASCII byte at ${i} would invalidate the xref table`)
    }
  }

  return new TextEncoder().encode(out)
}
