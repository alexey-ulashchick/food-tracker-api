import { ApiError, defaultHeaders } from './client'

// Server-sent-events parsing, ported from the manual frame reader in
// CalTracker/APIClient.swift (streamRecommend). Split into a pure incremental
// parser plus a thin fetch driver so the framing rules — which are the fiddly
// part — can be tested without a network.

export type SseEvent = { event: string; data: string }

/**
 * Incremental SSE frame parser.
 *
 * Handles the parts of the spec this app actually relies on:
 *   * an event is one or more `field: value` lines ended by a blank line;
 *   * multiple `data:` lines in one event join with a newline;
 *   * a line starting with `:` is a comment — that is the heartbeat
 *     POST /chat/stream sends to keep Fly's proxy from dropping the socket;
 *   * `id:` and `retry:` are accepted and ignored;
 *   * a trailing event with no blank line after it is still delivered, via
 *     flush() — some servers omit it on close.
 *
 * Chunk boundaries are arbitrary, so a partial line is buffered until the rest
 * arrives.
 */
export function createSseParser() {
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let sawAnyField = false

  const reset = () => {
    eventName = ''
    dataLines = []
    sawAnyField = false
  }

  const takeEvent = (): SseEvent | null => {
    if (!sawAnyField) return null
    // Per spec an event with no explicit name is a "message".
    const out = { event: eventName || 'message', data: dataLines.join('\n') }
    reset()
    return out
  }

  const consumeLine = (raw: string, out: SseEvent[]) => {
    // Tolerate CRLF as well as LF.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line === '') {
      const event = takeEvent()
      if (event) out.push(event)
      return
    }
    if (line.startsWith(':')) return // comment / heartbeat

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single leading space after the colon is part of the framing, not data.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        eventName = value
        sawAnyField = true
        break
      case 'data':
        dataLines.push(value)
        sawAnyField = true
        break
      case 'id':
      case 'retry':
        // Accepted and ignored: this client never reconnects with Last-Event-ID.
        break
      default:
        // Unknown fields are ignored, per spec.
        break
    }
  }

  return {
    /** Feeds a chunk of text and returns whatever events completed. */
    push(chunk: string): SseEvent[] {
      buffer += chunk
      const out: SseEvent[] = []
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline), out)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      return out
    },

    /** Call once the stream ends, to release a frame with no trailing blank line. */
    flush(): SseEvent[] {
      const out: SseEvent[] = []
      if (buffer.length > 0) {
        consumeLine(buffer, out)
        buffer = ''
      }
      const event = takeEvent()
      if (event) out.push(event)
      return out
    },
  }
}

export type SseHandler = (event: SseEvent) => void

/**
 * Opens an SSE request and dispatches frames as they arrive.
 *
 * A non-2xx response is drained and thrown as an ApiError so the caller can
 * show the message — the Swift client does the same, since an error body on
 * this endpoint is always short.
 */
export async function streamSse(
  path: string,
  init: RequestInit,
  onEvent: SseHandler,
): Promise<void> {
  const res = await fetch(path, {
    ...init,
    headers: { ...defaultHeaders(), Accept: 'text/event-stream', ...init.headers },
  })

  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''))
  if (!res.body) throw new ApiError(0, 'response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // stream: true keeps multi-byte characters intact across chunk splits,
      // which matters because every payload here is Russian text.
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        onEvent(event)
      }
    }
    for (const event of parser.flush()) onEvent(event)
  } finally {
    reader.releaseLock()
  }
}
