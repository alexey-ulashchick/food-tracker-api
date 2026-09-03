// Compile-time guard that shared/types.ts still describes what the API
// actually puts on the wire. The shared types are hand-written (the browser
// bundle must not pull in drizzle), so nothing else would catch a column
// rename or a new NOT NULL field drifting away from the client's view.
//
// This file emits no runtime code — it is types only. `bun run typecheck`
// fails the moment a row type and its wire twin disagree.

import type {
  ServerChatMessage,
  ServerGoal,
  ServerMeal,
  ServerMemory,
  ServerWeight,
} from '../../shared/types.ts'
import type { chatMessages, dailyGoals, meals, memories, weights } from './schema.ts'

/**
 * Hono's c.json() serialises Date to an ISO string; model that here.
 *
 * The tuple wrappers matter twice over: they stop the conditional from
 * distributing across `Date | null`, and they keep the test directional.
 * Writing it as `Date extends T[K]` would be true for `unknown` too, which
 * silently rewrote the jsonb `meta` column to `string | null`.
 */
type Jsonified<T> = {
  [K in keyof T]: [T[K]] extends [Date]
    ? string
    : [T[K]] extends [Date | null]
      ? string | null
      : T[K]
}

/** Collapses an intersection into a single object type. Without this, Equals
 *  reports `A & B` and its flattened twin as different. */
type Flatten<T> = { [K in keyof T]: T[K] }

/**
 * Invariant type equality. The identity-function trick is what makes this
 * strict: two types are equal only if the conditional resolves the same way
 * for an unresolved type parameter, which rules out the mutual-assignability
 * loopholes that `A extends B ? B extends A` lets through.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false

/**
 * Errors unless T is exactly `true`. Note this must NOT be written as
 * `T extends true`: `never` extends everything, so a constraint would let a
 * failed comparison through silently. Assigning to `true` does not.
 */
type Expect<T extends true> = T

// `localDate` is bolted on by decorateLocalDate / fetchMealsByLocalDateRange
// in src/lib/mealLocalDate.ts, so it is not part of the row type.
export type WireChecks = [
  Expect<
    Equals<Flatten<Jsonified<typeof meals.$inferSelect> & { localDate: string }>, ServerMeal>
  >,
  Expect<Equals<Flatten<Jsonified<typeof dailyGoals.$inferSelect>>, ServerGoal>>,
  Expect<Equals<Flatten<Jsonified<typeof memories.$inferSelect>>, ServerMemory>>,
  Expect<Equals<Flatten<Jsonified<typeof weights.$inferSelect>>, ServerWeight>>,
  // chat_messages.meta is jsonb — `unknown` on both sides.
  Expect<Equals<Flatten<Jsonified<typeof chatMessages.$inferSelect>>, ServerChatMessage>>,
]
