import type { ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse()
  }
  console.error('[error]', err)
  return c.json(
    { error: err instanceof Error ? err.message : 'Internal server error' },
    500,
  )
}
