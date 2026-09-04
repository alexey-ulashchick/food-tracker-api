import type {
  ChatPostResponse,
  DeleteAck,
  ServerChatMessage,
  ServerDaySummary,
  ServerGoal,
  ServerMeal,
  ServerMemory,
  ServerWeight,
} from '@shared/types.ts'
import { api } from './client'
import { type SseHandler, streamSse } from './sse'

// One wrapper per backend route. Paths are relative: same origin in production,
// proxied by Vite in dev (see the API_PATHS list in vite.config.ts).
//
// GETs retry twice on transport failure, mutations never do — the policy the
// Swift client used.

const GET = { retries: 2 } as const

/** Cap the backend enforces on GET /meals. */
const MEALS_LIMIT = 500

/** Default page the Swift client asked for; enough for the chat surface. */
export const CHAT_HISTORY_LIMIT = 60

export function listMeals(dateFrom: string, dateTo: string): Promise<ServerMeal[]> {
  const q = new URLSearchParams({ dateFrom, dateTo, limit: String(MEALS_LIMIT) })
  return api<ServerMeal[]>(`/meals?${q}`, GET)
}

/**
 * Every configured goal, in one request.
 *
 * The Swift History tab fanned out `GET /goals?date=` once per day that had
 * meals — up to 14 round-trips per page — even though this endpoint existed.
 * The web client only ever uses this form.
 */
export function listGoals(): Promise<ServerGoal[]> {
  return api<ServerGoal[]>('/goals', GET)
}

export async function getGoal(date: string): Promise<ServerGoal | null> {
  const rows = await api<ServerGoal[]>(`/goals?date=${date}`, GET)
  return rows[0] ?? null
}

export function daySummaries(from: string, to: string): Promise<ServerDaySummary[]> {
  return api<ServerDaySummary[]>(`/day-summary?from=${from}&to=${to}`, GET)
}

/** Newest-first, as the backend returns it; callers reverse for display. */
export function listChat(limit = CHAT_HISTORY_LIMIT): Promise<ServerChatMessage[]> {
  return api<ServerChatMessage[]>(`/chat?limit=${limit}`, GET)
}

export function listMemories(): Promise<ServerMemory[]> {
  return api<ServerMemory[]>('/memories', GET)
}

export function createMemory(content: string): Promise<ServerMemory> {
  return api<ServerMemory>('/memories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export function updateMemory(id: string, content: string): Promise<ServerMemory> {
  return api<ServerMemory>(`/memories/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export function deleteMemory(id: string): Promise<DeleteAck> {
  return api<DeleteAck>(`/memories/${id}`, { method: 'DELETE' })
}

export function listWeights(from?: string, to?: string): Promise<ServerWeight[]> {
  const q = new URLSearchParams()
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  const query = q.toString()
  return api<ServerWeight[]>(`/weights${query ? `?${query}` : ''}`, GET)
}

/** Non-streaming chat, kept for reference; the UI uses streamChat. */
export function postChat(content: string): Promise<ChatPostResponse> {
  return api<ChatPostResponse>('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

export type ChatAttachment = {
  /** Full-size file, forwarded to Anthropic and then discarded server-side. */
  file: File
  /** Downscaled data: URL, the only copy that survives in chat history. */
  thumb: string
}

export function streamChat(
  content: string,
  attachment: ChatAttachment | null,
  onEvent: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData()
  form.set('content', content)
  if (attachment) {
    form.set('image', attachment.file)
    form.set('thumb', attachment.thumb)
  }
  // No Content-Type header: the browser has to set the multipart boundary.
  return streamSse('/chat/stream', { method: 'POST', body: form, signal }, onEvent)
}

export function streamRecommend(onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  return streamSse('/chat/recommend', { method: 'POST', signal }, onEvent)
}

export function health(): Promise<{ status: string }> {
  return api<{ status: string }>('/health', GET)
}
