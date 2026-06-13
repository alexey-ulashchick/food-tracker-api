import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env.ts'

export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
})

// Sensible defaults — Sonnet 4.6 hits the price/quality sweet spot for chat.
// Override per-call when needed.
export const DEFAULT_MODEL = 'claude-sonnet-4-6'
export const DEFAULT_MAX_TOKENS = 1024
