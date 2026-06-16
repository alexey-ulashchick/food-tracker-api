import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { type Context, Hono } from 'hono'
import { type AuthEnv, auth } from '../middleware/auth.ts'
import { tokenAuth } from '../middleware/tokenAuth.ts'
import { buildMcpServer } from './server.ts'

// Stateless Streamable HTTP MCP endpoint. Each request gets a fresh
// McpServer + transport so userId stays scoped to the request via closure
// (see buildMcpServer). enableJsonResponse keeps replies as plain
// application/json instead of SSE — simpler for the Bun runtime and fine for
// short tool calls.
async function handleMcp(c: Context<AuthEnv>) {
  const userId = c.get('userId')
  const server = buildMcpServer(userId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
}

// Two front-doors with different auth, same handler:
//   * POST /mcp           — X-User-Id header (Claude Desktop, curl)
//   * POST /mcp/:token    — bearer token in URL path (mobile Claude, which
//                            can't inject custom headers)
export const mcpRoute = new Hono<AuthEnv>()
  .all('/', auth, handleMcp)
  .all('/:token', tokenAuth, handleMcp)
