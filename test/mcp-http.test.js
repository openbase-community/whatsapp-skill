import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  createWhatsAppMcpHttpServer,
  startWhatsAppMcpHttpServer,
} from '../mcp-http-server.js'

function withTempRoot() {
  return mkdtempSync(join(tmpdir(), 'whatsapp-mcp-http-test-'))
}

function closeHttpServer(httpServer) {
  return new Promise((resolve, reject) => {
    httpServer.close(err => err ? reject(err) : resolve())
  })
}

test('HTTP MCP server exposes WhatsApp tools over Streamable HTTP', async () => {
  const root = withTempRoot()
  const service = await startWhatsAppMcpHttpServer({ root, port: 0 })
  const client = new Client({ name: 'whatsapp-mcp-http-test', version: '0.1.0' })

  try {
    const transport = new StreamableHTTPClientTransport(new URL(service.url))
    await client.connect(transport)
    const { tools } = await client.listTools()

    assert.deepEqual(tools.map(tool => tool.name), [
      'list_contacts',
      'search_contacts',
      'list_recent_messages',
    ])
  } finally {
    await client.close().catch(() => {})
    await closeHttpServer(service.httpServer)
    rmSync(root, { recursive: true, force: true })
  }
})

test('HTTP MCP health check returns service status', async () => {
  const root = withTempRoot()
  const service = await startWhatsAppMcpHttpServer({ root, port: 0 })

  try {
    const response = await fetch(`http://${service.host}:${service.port}/health`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.service, 'whatsapp-mcp')
    assert.equal(body.endpoint, '/mcp')
  } finally {
    await closeHttpServer(service.httpServer)
    rmSync(root, { recursive: true, force: true })
  }
})

test('HTTP MCP server requires a token for non-local binds', () => {
  const root = withTempRoot()

  try {
    assert.throws(
      () => createWhatsAppMcpHttpServer({ root, host: '0.0.0.0', port: 0 }),
      /WHATSAPP_MCP_TOKEN/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
