// Port of the markdown normaliser in CalTracker/ChatBubble.swift.
//
// The Swift bubble parses with `.inlineOnlyPreservingWhitespace`, which renders
// **bold**, *italic*, `code` and [links] but leaves block syntax as literal
// characters. So headings and bullets are rewritten to inline equivalents
// first — without this the LLM's "## Записал" and "- 1 банан" show their raw
// markers in the bubble.

const HEADING_RE = /^#{1,6}\s+/
const BULLET_RE = /^(\s*)[-*+]\s+/

/** Rewrites block-level markdown to inline, line by line. */
export function normalizeMarkdown(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      const heading = HEADING_RE.exec(line)
      if (heading) return `**${line.slice(heading[0].length)}**`

      const bullet = BULLET_RE.exec(line)
      if (bullet) return `${bullet[1]}•  ${line.slice(bullet[0].length)}`

      return line
    })
    .join('\n')
}

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

// Ordered by precedence. Bold is matched before italic so `**x**` is not read
// as two nested italics, and code before everything else so markers inside a
// span of code stay literal.
const INLINE_PATTERNS: Array<{ re: RegExp; build: (m: RegExpExecArray) => InlineToken }> = [
  { re: /`([^`]+)`/, build: (m) => ({ kind: 'code', text: m[1]! }) },
  { re: /\*\*([^*]+)\*\*/, build: (m) => ({ kind: 'bold', text: m[1]! }) },
  { re: /__([^_]+)__/, build: (m) => ({ kind: 'bold', text: m[1]! }) },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, build: (m) => ({ kind: 'link', text: m[1]!, href: m[2]! }) },
  { re: /\*([^*]+)\*/, build: (m) => ({ kind: 'italic', text: m[1]! }) },
  { re: /_([^_]+)_/, build: (m) => ({ kind: 'italic', text: m[1]! }) },
]

/**
 * Splits one line into inline tokens. Deliberately small: the bubble only ever
 * renders what an LLM reply contains, and anything unrecognised falls through
 * as plain text rather than being dropped.
 */
export function parseInline(line: string): InlineToken[] {
  const out: InlineToken[] = []
  let rest = line

  while (rest.length > 0) {
    let best: { index: number; length: number; token: InlineToken } | null = null
    for (const { re, build } of INLINE_PATTERNS) {
      const m = re.exec(rest)
      if (!m) continue
      // Earliest match wins; ties go to the higher-precedence pattern, which
      // is why this only replaces `best` on a strictly smaller index.
      if (!best || m.index < best.index) {
        best = { index: m.index, length: m[0].length, token: build(m) }
      }
    }

    if (!best) {
      out.push({ kind: 'text', text: rest })
      break
    }
    if (best.index > 0) out.push({ kind: 'text', text: rest.slice(0, best.index) })
    out.push(best.token)
    rest = rest.slice(best.index + best.length)
  }

  return out.filter((t) => t.kind !== 'text' || t.text.length > 0)
}
