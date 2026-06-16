import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { type AuthEnv, auth } from '../middleware/auth.ts'
import { buildMcpServer } from './server.ts'

// Stateless Streamable HTTP MCP endpoint. Each request gets a fresh
// McpServer + transport so userId stays scoped to the request via closure
// (see buildMcpServer). enableJsonResponse keeps replies as plain
// application/json instead of SSE — simpler for the Bun runtime and fine for
// short tool calls.
export const mcpRoute = new Hono<AuthEnv>().use(auth).all('/', async (c) => {
  const userId = c.get('userId')
  const server = buildMcpServer(userId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})
