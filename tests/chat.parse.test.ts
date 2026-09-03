import { describe, expect, test } from 'bun:test'
import { parseChatRequest } from '../src/routes/chat.ts'

// parseChatRequest is the one part of the chat surface with no DB dependency,
// so it gets its own file. The route-level behaviour (persistence, the tool
// loop, the write-claim guard) lives in chat.test.ts.

const PNG_THUMB = 'data:image/png;base64,iVBORw0KGgo='
const imageFile = () => new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' })

function multipart(build: (fd: FormData) => void): Request {
  const fd = new FormData()
  build(fd)
  return new Request('http://x/chat', { method: 'POST', body: fd })
}

function json(body: unknown): Request {
  return new Request('http://x/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('parseChatRequest — content', () => {
  test('requires non-empty content even when a photo is attached', async () => {
    const r = await parseChatRequest(multipart((f) => f.set('image', imageFile())))
    expect(r).toMatchObject({ ok: false, error: 'content is required' })
  })

  test('caps content at 10000 chars', async () => {
    const ok = await parseChatRequest(multipart((f) => f.set('content', 'x'.repeat(10_000))))
    expect(ok.ok).toBe(true)

    const tooLong = await parseChatRequest(multipart((f) => f.set('content', 'x'.repeat(10_001))))
    expect(tooLong.ok).toBe(false)
  })

  test('accepts a JSON body for text-only turns', async () => {
    const r = await parseChatRequest(json({ content: 'привет' }))
    expect(r).toMatchObject({ ok: true, value: { content: 'привет', image: null, thumb: null } })
  })
})

describe('parseChatRequest — image', () => {
  test('accepts the four types Anthropic supports', async () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      const r = await parseChatRequest(
        multipart((f) => {
          f.set('content', 'hi')
          f.set('image', new File([new Uint8Array([1])], 'a', { type }))
        }),
      )
      expect(r.ok).toBe(true)
    }
  })

  test('rejects any other type', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', new File([new Uint8Array([1])], 'a.tiff', { type: 'image/tiff' }))
      }),
    )
    expect(r).toMatchObject({ ok: false, error: 'unsupported image type: image/tiff' })
  })
})

describe('parseChatRequest — thumb', () => {
  test('keeps a valid data URL', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', imageFile())
        f.set('thumb', PNG_THUMB)
      }),
    )
    expect(r).toMatchObject({ ok: true, value: { thumb: PNG_THUMB } })
  })

  // A thumb alone would render a photo bubble for a message that never
  // carried one.
  test('rejects a thumb with no image', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('thumb', PNG_THUMB)
      }),
    )
    expect(r).toMatchObject({ ok: false, error: 'thumb requires an image' })
  })

  test('rejects a thumb over the 40 KB ceiling', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', imageFile())
        f.set('thumb', `data:image/webp;base64,${'A'.repeat(41_000)}`)
      }),
    )
    expect(r).toMatchObject({ ok: false, error: 'thumb too large' })
  })

  test('rejects a remote URL', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', imageFile())
        f.set('thumb', 'https://evil.example/x.png')
      }),
    )
    expect(r.ok).toBe(false)
  })

  // SVG can execute script, and the thumb is replayed into an <img> in chat
  // history — so the allow-list is raster formats only.
  test('rejects an SVG data URL', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', imageFile())
        f.set('thumb', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
      }),
    )
    expect(r.ok).toBe(false)
  })

  // The iOS client predates the thumb field and must keep working untouched.
  test('an image with no thumb still parses', async () => {
    const r = await parseChatRequest(
      multipart((f) => {
        f.set('content', 'hi')
        f.set('image', imageFile())
      }),
    )
    expect(r).toMatchObject({ ok: true, value: { thumb: null } })
    expect((r as { ok: true; value: { image: unknown } }).value.image).not.toBeNull()
  })

  test('the JSON path ignores a thumb field entirely', async () => {
    const r = await parseChatRequest(json({ content: 'hi', thumb: PNG_THUMB }))
    expect(r).toMatchObject({ ok: true, value: { thumb: null } })
  })
})
