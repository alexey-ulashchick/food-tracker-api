import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env.ts'

export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
})

// Sensible defaults — Sonnet 4.6 hits the price/quality sweet spot for chat.
// Override per-call when needed.
export const DEFAULT_MODEL = 'claude-sonnet-4-6'
// Roomy enough for the model to emit many tool_use blocks in a single turn
// (e.g. setting goals for a whole range of days) plus a closing recap without
// getting truncated with stop_reason='max_tokens'. Output is billed per token
// actually generated, so short turns are unaffected by the higher ceiling.
export const DEFAULT_MAX_TOKENS = 4096

// Per-million-token prices, USD. Mirrors anthropic.com/pricing for the
// models we actually use. Cache creation is the same as input on the new
// pricing page (5m TTL); cache read is 10× cheaper. If we ever swap models
// dynamically, this map gets the new key — chat.ts looks up by model id.
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-opus-4-7': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-haiku-4-5-20251001': {
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
}

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  costUsd: number
}

// Computes USD cost for a single Anthropic response usage block. Falls back
// to Sonnet pricing if the model isn't in the table — better than throwing,
// and the eventual log line will surface the unknown model id.
export function priceUsage(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number | null
    cache_read_input_tokens?: number | null
  },
): Usage {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['claude-sonnet-4-6']!
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const costUsd =
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheCreationTokens * p.cacheWrite +
      cacheReadTokens * p.cacheRead) /
    1_000_000
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd }
}
