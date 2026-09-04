import type Anthropic from '@anthropic-ai/sdk'

// Scripted stand-in for the Anthropic client, used only when E2E_FAKE_LLM=1.
//
// It answers deterministically off the last user message so the end-to-end
// suite can exercise a real turn end to end — streaming deltas, a tool call, an
// action card, the closing recap — with no key and no spend.
//
// It is NOT a general mock: the unit tests mock the SDK module directly (see
// tests/setup.ts) and can script any sequence they like.

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function message(content: Block[], stopReason: string) {
  return {
    id: `msg_fake_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    stop_sequence: null,
    stop_reason: stopReason,
    content,
    usage: { input_tokens: 120, output_tokens: 40 },
  } as unknown as Anthropic.Message
}

function lastUserText(params: { messages?: Array<{ role: string; content: unknown }> }): string {
  const messages = params.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      const text = m.content.find(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text',
      )
      if (text) return text.text
    }
  }
  return ''
}

/**
 * Decides the turn from the prompt.
 *
 * A message mentioning an apple logs one; anything else gets a plain reply. The
 * `tools` key tells the two halves of a tool turn apart: runToolLoop's wrap-up
 * call omits it.
 */
function scriptFor(params: {
  messages?: Array<{ role: string; content: unknown }>
  tools?: unknown
}): Anthropic.Message {
  const text = lastUserText(params).toLowerCase()
  const alreadyRanTool = (params.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
      ),
  )

  if (text.includes('яблоко') && !alreadyRanTool) {
    return message(
      [
        {
          type: 'tool_use',
          id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
          name: 'add_meal',
          input: {
            meal: 'Snack',
            emoji: '🍎',
            foodName: 'Яблоко',
            calories: 95,
            protein: 0,
            carbs: 25,
            fats: 0,
          },
        },
      ],
      'tool_use',
    )
  }

  if (alreadyRanTool) {
    return message([{ type: 'text', text: 'Записал яблоко. Осталось ещё немного до цели.' }], 'end_turn')
  }

  return message([{ type: 'text', text: 'Привет! Расскажи, что ты съел.' }], 'end_turn')
}

/** Minimal MessageStream surface: the two members runToolLoop uses. */
function fakeStream(params: Parameters<typeof scriptFor>[0]) {
  const final = scriptFor(params)
  const handlers: Array<(event: unknown) => void> = []

  return {
    on(_event: string, fn: (event: unknown) => void) {
      handlers.push(fn)
      return this
    },
    async finalMessage() {
      // Replay the wire events the real SDK emits, so the client sees deltas
      // arriving in pieces rather than one blob.
      final.content.forEach((block, index) => {
        if (block.type === 'text') {
          for (const piece of block.text.match(/.{1,6}/g) ?? []) {
            for (const h of handlers) {
              h({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
            }
          }
        } else if (block.type === 'tool_use') {
          for (const h of handlers) {
            h({
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', name: block.name },
            })
          }
        }
      })
      return final
    },
  }
}

export const fakeAnthropic = {
  messages: {
    create: async (params: Parameters<typeof scriptFor>[0]) => scriptFor(params),
    stream: (params: Parameters<typeof scriptFor>[0]) => fakeStream(params),
  },
} as unknown as Anthropic
