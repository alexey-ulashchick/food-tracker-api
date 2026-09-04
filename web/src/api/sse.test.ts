import { describe, expect, test } from 'vitest'
import { createSseParser } from './sse'

// Framing rules are the fiddly part of SSE, and they are exactly what broke in
// the Swift client's early versions (a trailing frame with no blank line after
// it was dropped). These run without a network.

const parse = (...chunks: string[]) => {
  const parser = createSseParser()
  const out = chunks.flatMap((c) => parser.push(c))
  return [...out, ...parser.flush()]
}

describe('createSseParser', () => {
  test('parses a single named event', () => {
    expect(parse('event: user\ndata: {"id":"1"}\n\n')).toEqual([
      { event: 'user', data: '{"id":"1"}' },
    ])
  })

  test('parses several events in one chunk', () => {
    expect(parse('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  test('joins multiple data lines with a newline', () => {
    expect(parse('event: x\ndata: line1\ndata: line2\n\n')).toEqual([
      { event: 'x', data: 'line1\nline2' },
    ])
  })

  test('strips exactly one space after the colon', () => {
    expect(parse('event: x\ndata:  two spaces\n\n')).toEqual([{ event: 'x', data: ' two spaces' }])
  })

  test('accepts a field with no space after the colon', () => {
    expect(parse('event:x\ndata:1\n\n')).toEqual([{ event: 'x', data: '1' }])
  })

  // The heartbeat POST /chat/stream sends to keep Fly's proxy alive.
  test('ignores comment lines', () => {
    expect(parse(': ping\n\nevent: x\ndata: 1\n\n')).toEqual([{ event: 'x', data: '1' }])
  })

  test('a comment between data lines does not split the event', () => {
    expect(parse('event: x\ndata: 1\n: ping\ndata: 2\n\n')).toEqual([{ event: 'x', data: '1\n2' }])
  })

  test('ignores id and retry fields', () => {
    expect(parse('id: 7\nretry: 3000\nevent: x\ndata: 1\n\n')).toEqual([{ event: 'x', data: '1' }])
  })

  test('defaults a nameless event to "message"', () => {
    expect(parse('data: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }])
  })

  // Chunk boundaries are arbitrary: the reader can split mid-line, mid-field
  // name, or between the two newlines that close a frame.
  test('reassembles an event split across chunks', () => {
    expect(parse('event: us', 'er\nda', 'ta: {"id":', '"1"}\n', '\n')).toEqual([
      { event: 'user', data: '{"id":"1"}' },
    ])
  })

  test('emits nothing until the blank line arrives', () => {
    const parser = createSseParser()
    expect(parser.push('event: x\ndata: 1\n')).toEqual([])
    expect(parser.push('\n')).toEqual([{ event: 'x', data: '1' }])
  })

  // Some servers close without the trailing blank line; the Swift client had to
  // flush too, or the last recommendation card went missing.
  test('flush delivers a trailing event with no blank line', () => {
    const parser = createSseParser()
    expect(parser.push('event: done\ndata: {"count":3}')).toEqual([])
    expect(parser.flush()).toEqual([{ event: 'done', data: '{"count":3}' }])
  })

  test('flush on a clean stream yields nothing', () => {
    const parser = createSseParser()
    parser.push('event: x\ndata: 1\n\n')
    expect(parser.flush()).toEqual([])
  })

  test('tolerates CRLF line endings', () => {
    expect(parse('event: x\r\ndata: 1\r\n\r\n')).toEqual([{ event: 'x', data: '1' }])
  })

  test('an empty data field is preserved', () => {
    expect(parse('event: x\ndata:\n\n')).toEqual([{ event: 'x', data: '' }])
  })

  test('consecutive blank lines do not produce empty events', () => {
    expect(parse('\n\n\nevent: x\ndata: 1\n\n\n\n')).toEqual([{ event: 'x', data: '1' }])
  })

  test('unknown fields are ignored without breaking the event', () => {
    expect(parse('event: x\nnonsense: 9\ndata: 1\n\n')).toEqual([{ event: 'x', data: '1' }])
  })

  test('carries Russian payloads through intact', () => {
    const data = JSON.stringify({ content: 'Записал творог — осталось 900 ккал' })
    expect(parse(`event: message\ndata: ${data}\n\n`)).toEqual([{ event: 'message', data }])
  })

  test('handles the real POST /chat/stream sequence', () => {
    const frames = [
      'event: user\ndata: {"id":"u1"}\n\n',
      ': ping\n\n',
      'event: delta\ndata: {"blockId":"0-0","text":"Запи"}\n\n',
      'event: delta\ndata: {"blockId":"0-0","text":"сал"}\n\n',
      'event: tool\ndata: {"name":"add_meal","status":"start"}\n\n',
      'event: tool\ndata: {"name":"add_meal","status":"ok"}\n\n',
      'event: card\ndata: {"kind":"meal_added"}\n\n',
      'event: usage\ndata: {"costUsd":0.004}\n\n',
      'event: done\ndata: {"count":2}\n\n',
    ]
    // Feed it one character at a time — the worst case a reader can produce.
    const parser = createSseParser()
    const out = frames
      .join('')
      .split('')
      .flatMap((ch) => parser.push(ch))
    out.push(...parser.flush())

    expect(out.map((e) => e.event)).toEqual([
      'user',
      'delta',
      'delta',
      'tool',
      'tool',
      'card',
      'usage',
      'done',
    ])
    expect(out.filter((e) => e.event === 'delta').map((e) => JSON.parse(e.data).text)).toEqual([
      'Запи',
      'сал',
    ])
  })
})
