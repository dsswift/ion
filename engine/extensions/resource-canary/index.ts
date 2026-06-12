// resource-canary -- end-to-end exerciser for the resource SDK.
//
// At init time, declares a "briefing" resource kind. Registers a
// query handler that returns a canned in-memory set of items. Exposes
// tools so integration tests can drive the full create/update/delete
// lifecycle and verify events arrive at broker subscribers.

import { createIon, log } from '../sdk/ion-sdk'
import type { ResourceFilter, ResourceItem } from '../sdk/ion-sdk'

const ion = createIon()

// In-memory store. Simulates producer-owned persistence.
const store: ResourceItem[] = [
  {
    id: 'briefing-1',
    kind: 'briefing',
    title: 'Morning Brief',
    content: '# Good morning\n\nHere is your daily summary.',
    createdAt: '2026-06-05T08:00:00Z',
  },
]

// resourceHandle is set once declare() resolves.
let resourceHandle: Awaited<ReturnType<typeof ion.resources.declare>> | null = null

// Declare the briefing kind at init time. Pre-init path queues the
// declaration into the init response; the engine picks it up via
// CommitPendingResourceDecls, which wires the resource/query handler
// back to this subprocess.
const initPromise = ion.resources.declare({ kind: 'briefing' }).then((handle) => {
  resourceHandle = handle
  log.info('resource-canary: briefing kind declared')
})

// Register query handler. Called by the engine via resource/query RPC
// when a client subscribes and needs the initial snapshot.
ion.resources.onQuery('briefing', (filter: ResourceFilter): ResourceItem[] => {
  log.info('resource-canary: query', { kind: filter.kind })
  let items = store
  if (filter.since) {
    items = items.filter((item) => item.createdAt >= filter.since!)
  }
  if (filter.limit && filter.limit > 0) {
    items = items.slice(0, filter.limit)
  }
  return items
})

// Tool: publish a new briefing item.
ion.registerTool({
  name: 'canary_publish_briefing',
  description: 'Publish a new briefing resource item',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['id', 'title', 'content'],
  },
  execute: async (params) => {
    await initPromise
    const item: ResourceItem = {
      id: params.id as string,
      kind: 'briefing',
      title: params.title as string,
      content: params.content as string,
      createdAt: new Date().toISOString(),
    }
    store.push(item)
    if (resourceHandle) {
      await resourceHandle.publish('create', item)
    }
    return { content: JSON.stringify({ published: item.id }) }
  },
})

// Tool: update an existing briefing item.
ion.registerTool({
  name: 'canary_update_briefing',
  description: 'Update a briefing resource item',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['id'],
  },
  execute: async (params) => {
    await initPromise
    const idx = store.findIndex((item) => item.id === (params.id as string))
    if (idx === -1) {
      return { content: JSON.stringify({ error: 'not found' }), isError: true }
    }
    if (params.title) store[idx] = { ...store[idx], title: params.title as string }
    if (params.content) store[idx] = { ...store[idx], content: params.content as string }
    store[idx] = { ...store[idx], updatedAt: new Date().toISOString() }
    if (resourceHandle) {
      await resourceHandle.publish('update', store[idx])
    }
    return { content: JSON.stringify({ updated: store[idx].id }) }
  },
})

// Tool: delete a briefing item.
ion.registerTool({
  name: 'canary_delete_briefing',
  description: 'Delete a briefing resource item',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  execute: async (params) => {
    await initPromise
    const idx = store.findIndex((item) => item.id === (params.id as string))
    if (idx === -1) {
      return { content: JSON.stringify({ error: 'not found' }), isError: true }
    }
    const [deleted] = store.splice(idx, 1)
    if (resourceHandle) {
      await resourceHandle.publish('delete', deleted)
    }
    return { content: JSON.stringify({ deleted: deleted.id }) }
  },
})

// Tool: list current in-memory store (for test verification).
ion.registerTool({
  name: 'canary_list_briefings',
  description: 'List all briefings currently in the in-memory store',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    return { content: JSON.stringify(store) }
  },
})

// Tool: send a notification (exercises ctx.notify pipeline).
ion.registerTool({
  name: 'canary_notify',
  description: 'Send a test notification through the engine notification pipeline',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      resourceId: { type: 'string' },
    },
    required: ['title', 'body'],
  },
  execute: async (params, ctx) => {
    await ctx.notify({
      kind: 'briefing',
      resourceId: (params.resourceId as string | undefined) ?? '',
      title: params.title as string,
      body: params.body as string,
    })
    return { content: JSON.stringify({ notified: true }) }
  },
})

// ─── Cross-session tools (E2E exercisers) ───

// Tool: list all active sessions via ctx.sessions.list().
ion.registerTool({
  name: 'canary_list_sessions',
  description: 'List all active sessions via ctx.sessions.list()',
  parameters: { type: 'object', properties: {} },
  execute: async (_params, ctx) => {
    const sessions = await ctx.sessions.list()
    return { content: JSON.stringify(sessions) }
  },
})

// Tool: send a cross-session message to another session.
ion.registerTool({
  name: 'canary_send_to_session',
  description: 'Send a cross-session message to another session',
  parameters: {
    type: 'object',
    properties: {
      targetKey: { type: 'string' },
      kind: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['targetKey', 'kind'],
  },
  execute: async (params, ctx) => {
    await ctx.sessions.send(
      params.targetKey as string,
      params.kind as string,
      { message: params.message ?? '' },
    )
    return { content: JSON.stringify({ sent: true }) }
  },
})

// Session message receiver: records cross-session messages for test verification.
const receivedSessionMessages: Array<{
  senderSessionKey: string
  kind: string
  payload: any
}> = []

ion.on('session_message', (_ctx, msg) => {
  receivedSessionMessages.push({
    senderSessionKey: msg.senderSessionKey,
    kind: msg.kind,
    payload: msg.payload,
  })
  log.info('session_message received', {
    from: msg.senderSessionKey,
    kind: msg.kind,
  })
})

// Tool: retrieve all received cross-session messages.
ion.registerTool({
  name: 'canary_get_received_messages',
  description: 'Get all received cross-session messages',
  parameters: { type: 'object', properties: {} },
  execute: async () => {
    return { content: JSON.stringify(receivedSessionMessages) }
  },
})

// Tool: send a notification targeted at a specific session.
ion.registerTool({
  name: 'canary_notify_target',
  description: 'Send a notification to a specific target session',
  parameters: {
    type: 'object',
    properties: {
      targetKey: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['targetKey', 'title', 'body'],
  },
  execute: async (params, ctx) => {
    await ctx.notify({
      kind: 'briefing',
      title: params.title as string,
      body: params.body as string,
      targetSessionKey: params.targetKey as string,
    })
    return { content: JSON.stringify({ notified: true }) }
  },
})
