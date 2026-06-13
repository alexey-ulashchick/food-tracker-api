import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { env } from './env.ts'
import { errorHandler } from './middleware/errors.ts'
import { chatRoute } from './routes/chat.ts'
import { goalsRoute } from './routes/goals.ts'
import { healthRoute } from './routes/health.ts'
import { mealsRoute } from './routes/meals.ts'

const app = new Hono()

app.use('*', logger())
app.onError(errorHandler)

// Public
app.route('/health', healthRoute)

// Authenticated (each route mounts its own `auth` middleware)
app.route('/meals', mealsRoute)
app.route('/goals', goalsRoute)
app.route('/chat', chatRoute)

console.log(`Listening on http://localhost:${env.PORT}`)

// Bun reads `export default { fetch, port }` and starts an HTTP server.
export default {
  fetch: app.fetch,
  port: env.PORT,
}
