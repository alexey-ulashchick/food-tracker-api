import { describe, expect, test } from 'vitest'
import { normalizeMarkdown, parseInline } from './markdown'

describe('normalizeMarkdown', () => {
  test('turns headings into bold, dropping the hashes', () => {
    expect(normalizeMarkdown('# Записал')).toBe('**Записал**')
    expect(normalizeMarkdown('### Итог дня')).toBe('**Итог дня**')
  })

  test('accepts all six heading levels but not seven hashes', () => {
    expect(normalizeMarkdown('###### six')).toBe('**six**')
    expect(normalizeMarkdown('####### seven')).toBe('####### seven')
  })

  test('a hash without a following space is not a heading', () => {
    expect(normalizeMarkdown('#hashtag')).toBe('#hashtag')
  })

  test('rewrites the three bullet markers to a bullet glyph', () => {
    expect(normalizeMarkdown('- банан')).toBe('•  банан')
    expect(normalizeMarkdown('* банан')).toBe('•  банан')
    expect(normalizeMarkdown('+ банан')).toBe('•  банан')
  })

  test('preserves bullet indentation', () => {
    expect(normalizeMarkdown('    - вложенный')).toBe('    •  вложенный')
  })

  test('leaves plain lines and blank lines alone', () => {
    expect(normalizeMarkdown('обычный текст')).toBe('обычный текст')
    expect(normalizeMarkdown('a\n\nb')).toBe('a\n\nb')
  })

  test('handles a whole multi-line reply', () => {
    const input = '## Записал\n- 1 латте\n- 1 банан\nОсталось 900 ккал.'
    expect(normalizeMarkdown(input)).toBe('**Записал**\n•  1 латте\n•  1 банан\nОсталось 900 ккал.')
  })

  // A heading test takes precedence over the bullet test on the same line,
  // matching the Swift if/else-if order.
  test('a heading wins over a bullet on the same line', () => {
    expect(normalizeMarkdown('# - что-то')).toBe('**- что-то**')
  })
})

describe('parseInline', () => {
  const kinds = (s: string) => parseInline(s).map((t) => t.kind)

  test('plain text is a single token', () => {
    expect(parseInline('привет')).toEqual([{ kind: 'text', text: 'привет' }])
  })

  test('recognises bold, italic and code', () => {
    expect(parseInline('**жир**')).toEqual([{ kind: 'bold', text: 'жир' }])
    expect(parseInline('*курсив*')).toEqual([{ kind: 'italic', text: 'курсив' }])
    expect(parseInline('`код`')).toEqual([{ kind: 'code', text: 'код' }])
    expect(parseInline('__жир__')).toEqual([{ kind: 'bold', text: 'жир' }])
    expect(parseInline('_курсив_')).toEqual([{ kind: 'italic', text: 'курсив' }])
  })

  test('bold is not mistaken for two italics', () => {
    expect(kinds('**жир**')).toEqual(['bold'])
  })

  test('splits surrounding text off correctly', () => {
    expect(parseInline('до **середина** после')).toEqual([
      { kind: 'text', text: 'до ' },
      { kind: 'bold', text: 'середина' },
      { kind: 'text', text: ' после' },
    ])
  })

  test('parses a link into text and href', () => {
    expect(parseInline('см. [доки](https://example.com)')).toEqual([
      { kind: 'text', text: 'см. ' },
      { kind: 'link', text: 'доки', href: 'https://example.com' },
    ])
  })

  test('markers inside code stay literal', () => {
    expect(parseInline('`**не жир**`')).toEqual([{ kind: 'code', text: '**не жир**' }])
  })

  test('handles several spans in one line', () => {
    expect(kinds('**a** и *b* и `c`')).toEqual(['bold', 'text', 'italic', 'text', 'code'])
  })

  test('an unclosed marker degrades to plain text rather than vanishing', () => {
    expect(parseInline('**незакрытый')).toEqual([{ kind: 'text', text: '**незакрытый' }])
    expect(parseInline('обычный * звёздочка')).toEqual([
      { kind: 'text', text: 'обычный * звёздочка' },
    ])
  })

  test('never drops characters', () => {
    for (const line of [
      'привет',
      '**a** b *c* `d` [e](http://f)',
      'a**b**c',
      '`x`y`z`',
      '__bold__ and _it_',
    ]) {
      const rebuilt = parseInline(line)
        .map((t) => t.text)
        .join('')
      // Markers are consumed, so compare against the line with them stripped.
      const stripped = line.replace(/\*\*|__|[*_`]|\[|\]\([^)]*\)/g, '')
      expect(rebuilt).toBe(stripped)
    }
  })

  test('an empty line yields no tokens', () => {
    expect(parseInline('')).toEqual([])
  })
})
