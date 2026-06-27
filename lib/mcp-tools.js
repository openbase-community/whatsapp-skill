import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { backfillApprovedContactFromArchive } from './whatsapp-backfill.js'
import {
  approveContact,
  createOutboundMessage,
  listApprovedContacts,
  listContacts,
  listRecentMessages,
  openWhatsAppDb,
  revokeContact,
  searchContacts,
} from './whatsapp-db.js'

export function createWhatsAppMcpServer({ root, db = null } = {}) {
  if (!root && !db) throw new Error('root or db is required')

  const whatsappDb = db ?? openWhatsAppDb({ root })
  const server = new McpServer({
    name: 'whatsapp-approved-contacts',
    version: '0.1.0',
  })

  registerWhatsAppTools(server, whatsappDb, { root })
  return server
}

export function registerWhatsAppTools(server, db, { root = null } = {}) {
  const adminTools = process.env.WHATSAPP_MCP_ADMIN === '1'
  const contactListTool = process.env.WHATSAPP_MCP_CONTACT_LIST === '1'
  const sendTool = process.env.WHATSAPP_MCP_SEND === '1'

  server.registerTool('list_contacts', {
    description: 'List stored WhatsApp contact/chat metadata by name. Returns contact IDs and permission flags only; never returns message bodies.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Maximum contacts to return. Defaults to 50.'),
      offset: z.number().int().min(0).optional().describe('Number of contacts to skip for pagination. Defaults to 0.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async ({ limit, offset }) => jsonResult({
    contacts: listContacts(db, { limit, offset }),
  }))

  server.registerTool('search_contacts', {
    description: 'Search stored WhatsApp contact/chat metadata by name or contact JID. Returns contact IDs and permission flags only; never returns message bodies.',
    inputSchema: {
      query: z.string().min(1).describe('Case-insensitive name, partial name, phone/JID, or group/contact label to search for.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum contacts to return. Defaults to 25.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async ({ query, limit }) => jsonResult({
    query,
    contacts: searchContacts(db, query, { limit }),
  }))

  if (contactListTool) {
    server.registerTool('list_approved_contacts', {
      description: 'List WhatsApp contacts/chats approved for this MCP server. Unapproved contacts are not returned.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    }, async () => jsonResult({ contacts: listApprovedContacts(db) }))
  }

  server.registerTool('list_recent_messages', {
    description: 'List the most recent stored messages for an approved WhatsApp contact/chat. There is no text search.',
    inputSchema: {
      contact_id: z.string().min(1).describe('Approved WhatsApp chat/contact JID.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum messages to return. Defaults to 25.'),
      before_timestamp_ms: z.number().int().positive().optional().describe('Only return messages older than this millisecond timestamp.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }, async ({ contact_id: contactId, limit, before_timestamp_ms: beforeTimestampMs }) => {
    try {
      return jsonResult({
        contact_id: contactId,
        messages: listRecentMessages(db, contactId, { limit, beforeTimestampMs }),
      })
    } catch (err) {
      return errorResult(err?.message ?? String(err))
    }
  })

  if (sendTool) {
    server.registerTool('send_message', {
      description: 'Queue a WhatsApp message to an approved send-enabled contact/chat. Delivery requires the Baileys archiver to run with WHATSAPP_SEND_OUTBOX=1.',
      inputSchema: {
        contact_id: z.string().min(1).describe('Approved WhatsApp chat/contact JID.'),
        text: z.string().min(1).max(4000).describe('Message text to queue.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }, async ({ contact_id: contactId, text }) => {
      try {
        return jsonResult({
          queued: createOutboundMessage(db, contactId, text),
          note: 'Queued locally. The archiver only sends queued messages when WHATSAPP_SEND_OUTBOX=1 is set.',
        })
      } catch (err) {
        return errorResult(err?.message ?? String(err))
      }
    })
  }

  if (adminTools) {
    server.registerTool('approve_contact', {
      description: 'Admin-only: approve a WhatsApp contact/chat by exact JID. Approval backfills recent archived messages for that contact and stores future messages in SQLite.',
      inputSchema: {
        contact_id: z.string().min(1).describe('Exact WhatsApp chat/contact JID to approve.'),
        display_name: z.string().min(1).optional().describe('Optional label for this contact/chat.'),
        read_allowed: z.boolean().optional().describe('Allow reading recent messages. Defaults to true.'),
        send_allowed: z.boolean().optional().describe('Allow queueing messages. Defaults to false.'),
        backfill_months: z.number().positive().max(24).optional().describe('Months of local JSON archive to backfill. Defaults to 6.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    }, async ({ contact_id: contactId, display_name: displayName, read_allowed: readAllowed, send_allowed: sendAllowed, backfill_months: backfillMonths }) => {
      try {
        const contact = approveContact(db, contactId, {
          displayName,
          readAllowed: readAllowed ?? true,
          sendAllowed: sendAllowed ?? false,
        })
        const shouldBackfill = (readAllowed ?? true) && root
        return jsonResult({
          contact,
          backfill: shouldBackfill
            ? backfillApprovedContactFromArchive(db, { root, contactId, months: backfillMonths })
            : { skipped: true, reason: root ? 'read not allowed' : 'archive root unavailable' },
        })
      } catch (err) {
        return errorResult(err?.message ?? String(err))
      }
    })

    server.registerTool('revoke_contact', {
      description: 'Admin-only: remove MCP access for a WhatsApp contact/chat. Existing rows remain hidden from MCP reads.',
      inputSchema: {
        contact_id: z.string().min(1).describe('Exact WhatsApp chat/contact JID to revoke.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    }, async ({ contact_id: contactId }) => {
      try {
        return jsonResult({ contact: revokeContact(db, contactId) })
      } catch (err) {
        return errorResult(err?.message ?? String(err))
      }
    })
  }
}

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}
