import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { openWhatsAppDb } from './lib/whatsapp-db.js'
import { createWhatsAppMcpServer } from './lib/mcp-tools.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

export function createWhatsAppMcpHttpServer({
  root = ROOT,
  host = process.env.WHATSAPP_MCP_HOST ?? '127.0.0.1',
  port = Number(process.env.WHATSAPP_MCP_PORT ?? 3055),
  endpoint = process.env.WHATSAPP_MCP_ENDPOINT ?? '/mcp',
  token = process.env.WHATSAPP_MCP_TOKEN ?? '',
} = {}) {
  assertNetworkBinding(host, token)

  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const httpServer = createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          service: 'whatsapp-mcp',
          endpoint: normalizedEndpoint,
        })
        return
      }

      const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
      if (pathname !== normalizedEndpoint) {
        sendJson(res, 404, jsonRpcError(-32004, 'Not found'))
        return
      }

      if (!isAuthorized(req, token)) {
        sendJson(res, 401, jsonRpcError(-32001, 'Unauthorized'), {
          'WWW-Authenticate': 'Bearer realm="whatsapp-mcp"',
        })
        return
      }

      if (req.method === 'POST') {
        const db = openWhatsAppDb({ root })
        const mcpServer = createWhatsAppMcpServer({ root, db })
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        })
        let cleanedUp = false
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          transport.close().catch(err => console.error('MCP HTTP transport close failed:', err))
          mcpServer.close().catch(err => console.error('MCP HTTP server close failed:', err))
          try { db.close() } catch (err) { console.error('MCP HTTP db close failed:', err) }
        }

        res.on('close', cleanup)

        await mcpServer.connect(transport)
        await transport.handleRequest(req, res)
        return
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        sendJson(res, 405, jsonRpcError(-32000, 'Method not allowed.'))
        return
      }

      sendJson(res, 405, jsonRpcError(-32000, 'Method not allowed.'))
    } catch (err) {
      console.error('MCP HTTP request failed:', err)
      if (!res.headersSent) sendJson(res, 500, jsonRpcError(-32603, 'Internal server error'))
      else res.end()
    }
  })

  return {
    httpServer,
    host,
    port,
    endpoint: normalizedEndpoint,
    url: `http://${host}:${port}${normalizedEndpoint}`,
  }
}

export function startWhatsAppMcpHttpServer(options = {}) {
  const service = createWhatsAppMcpHttpServer(options)

  return new Promise((resolve, reject) => {
    const onError = err => {
      service.httpServer.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      service.httpServer.off('error', onError)
      const address = service.httpServer.address()
      const actualPort = typeof address === 'object' && address ? address.port : service.port
      resolve({
        ...service,
        port: actualPort,
        url: `http://${service.host}:${actualPort}${service.endpoint}`,
      })
    }

    service.httpServer.once('error', onError)
    service.httpServer.once('listening', onListening)
    service.httpServer.listen(service.port, service.host)
  })
}

function assertNetworkBinding(host, token) {
  if (token || LOCAL_HOSTS.has(host)) return
  if (process.env.WHATSAPP_MCP_ALLOW_UNAUTHENTICATED_LAN === '1') return
  throw new Error(
    'Refusing to bind WhatsApp MCP to a non-local host without WHATSAPP_MCP_TOKEN. ' +
    'Set WHATSAPP_MCP_TOKEN or WHATSAPP_MCP_ALLOW_UNAUTHENTICATED_LAN=1.'
  )
}

function isAuthorized(req, token) {
  if (!token) return true
  const authorization = req.headers.authorization ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  return bearer === token || req.headers['x-whatsapp-mcp-token'] === token
}

function jsonRpcError(code, message) {
  return {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  }
}

function sendJson(res, statusCode, value, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(value))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWhatsAppMcpHttpServer()
    .then(({ url }) => {
      console.log(`WhatsApp MCP HTTP server listening at ${url}`)
    })
    .catch(err => {
      console.error('MCP HTTP server failed:', err)
      process.exit(1)
    })
}
