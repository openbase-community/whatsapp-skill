import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createWhatsAppMcpServer } from './lib/mcp-tools.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const server = createWhatsAppMcpServer({ root: ROOT })

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  console.error('MCP server failed:', err)
  process.exit(1)
})
