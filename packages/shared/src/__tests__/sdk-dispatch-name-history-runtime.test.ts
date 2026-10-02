import { afterEach, describe, expect, it, vi } from 'vitest'

// Pins the TypeScript SDK side of ambiguous name resolution, terminal dispatch
// history, and the dispatch conversation read: the fields the engine answers
// with must reach the caller.

const { lineHandlers } = vi.hoisted(() => ({
  lineHandlers: [] as Array<(line: string) => void>,
}))

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === 'line') lineHandlers.push(handler)
      return undefined
    },
  })),
}))

afterEach(() => {
  lineHandlers.length = 0
  vi.restoreAllMocks()
  vi.resetModules()
})

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }

// runTool starts the SDK, registers one tool whose body is `body`, invokes it,
// and answers the first request for `method` with `response` (or with a
// JSON-RPC `error` when given). Resolves with the tool's JSON-encoded content.
async function runTool(
  body: (ctx: import('../../../../engine/extensions/sdk/ion-sdk/types').IonContext) => Promise<unknown>,
  method: string,
  response: unknown,
  error?: { code: number; message: string; data?: unknown },
  inspectParams?: (params: Record<string, unknown> | undefined) => void,
): Promise<unknown> {
  const writes: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)

  const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
  const ion = runtime.createIon()
  ion.registerTool({
    name: 'probe',
    description: 'probe',
    parameters: {},
    execute: async (_params, ctx) => ({ content: JSON.stringify(await body(ctx)), isError: false }),
  })
  await nextTurn()
  const line = lineHandlers.at(-1)
  expect(line).toBeDefined()

  line!('{"jsonrpc":"2.0","id":1,"method":"tool/probe","params":{"_ctx":{}}}')
  await nextTurn()
  const frames = (): Frame[] => writes.map((write) => JSON.parse(write) as Frame)
  const call = frames().find((frame) => frame.method === method)
  expect(call, `${method} was not sent`).toBeDefined()
  inspectParams?.(call!.params)
  line!(JSON.stringify(error
    ? { jsonrpc: '2.0', id: call!.id, error }
    : { jsonrpc: '2.0', id: call!.id, result: response }))
  await nextTurn()
  await nextTurn()

  const reply = frames().find((frame) => frame.id === 1 && frame.result !== undefined)
  expect(reply, 'tool reply was not sent').toBeDefined()
  const content = (reply!.result as { content: string }).content
  return JSON.parse(content)
}

describe('TypeScript SDK name resolution and dispatch history', () => {
  it('surfaces an ambiguous steer with its matching dispatch ids', async () => {
    const result = await runTool(
      (ctx) => ctx.steerDispatchByName('worker', 'redirect'),
      'ext/steer_dispatch_by_name',
      { delivered: false, outcome: 'ambiguous', matchingDispatchIds: ['d-1', 'd-2'] },
    )
    expect(result).toEqual({ delivered: false, outcome: 'ambiguous', matchingDispatchIds: ['d-1', 'd-2'] })
  })

  it('surfaces an ambiguous recall with its matching dispatch ids', async () => {
    const result = await runTool(
      (ctx) => ctx.recallAgentByName('worker', { reason: 'stop' }),
      'ext/recall_agent',
      { found: false, outcome: 'ambiguous', matchingDispatchIds: ['d-1', 'd-2'] },
    )
    expect(result).toEqual({ found: false, outcome: 'ambiguous', matchingDispatchIds: ['d-1', 'd-2'] })
  })

  it('reads an engine that answers recall with found only', async () => {
    const result = await runTool(
      (ctx) => ctx.recallAgentByName('worker'),
      'ext/recall_agent',
      { found: true },
    )
    expect(result).toEqual({ found: true, outcome: 'recalled' })
  })

  it('returns retained terminal dispatches from listDispatchHistory', async () => {
    const entry = {
      dispatchId: 'd-1', name: 'worker', status: 'error', reason: 'boom', exitCode: 1,
      parentDispatchId: 'd-0', depth: 2, startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z', durationMs: 1000, toolCount: 4,
    }
    const result = await runTool(
      (ctx) => ctx.listDispatchHistory(),
      'ext/list_dispatch_history',
      { dispatches: [entry] },
    )
    expect(result).toEqual([entry])
  })

  it('returns a typed dispatch conversation page and sends the read options', async () => {
    const page = {
      outcome: 'ok', conversationId: 'conv-1', dispatchId: 'd-1', agentName: 'worker',
      status: 'running', terminal: false, nextCursor: 'c-2', hasMore: true, totalEntries: 7,
      limits: { entries: 5, bytes: 4096, maxEntries: 200, maxBytes: 262144 },
      entries: [{
        id: 'e-1', role: 'assistant', timestamp: 10,
        blocks: [
          { type: 'text', text: 'reading' },
          { type: 'tool_call', toolCallId: 't-1', toolName: 'Read', input: { path: '/a' } },
        ],
      }],
    }
    const opts = { conversationId: 'conv-1', cursor: 'c-1', limit: 5, maxBytes: 4096 }
    const result = await runTool(
      (ctx) => ctx.readDispatchConversation(opts),
      'ext/read_dispatch_conversation',
      page,
      undefined,
      (params) => expect(params).toEqual(opts),
    )
    expect(result).toEqual(page)
  })

  it('keeps a refused dispatch conversation read as a typed outcome', async () => {
    const refused = { outcome: 'unauthorized', terminal: false, entries: [], hasMore: false, totalEntries: 0 }
    const result = await runTool(
      (ctx) => ctx.readDispatchConversation({ conversationId: 'conv-sibling' }),
      'ext/read_dispatch_conversation',
      refused,
    )
    expect(result).toEqual(refused)
  })

  it('reports an engine without the dispatch conversation read as unsupported', async () => {
    const result = await runTool(
      (ctx) => ctx.readDispatchConversation({ dispatchId: 'd-1' }),
      'ext/read_dispatch_conversation',
      undefined,
      { code: -32601, message: 'Method not found' },
    )
    expect(result).toEqual({ outcome: 'unsupported', terminal: false, entries: [], hasMore: false, totalEntries: 0 })
  })

  it('still rejects a dispatch conversation read that fails in the engine', async () => {
    const result = await runTool(
      (ctx) => ctx.readDispatchConversation({ dispatchId: 'd-1' }).then(
        () => 'resolved',
        (err: Error) => `rejected: ${err.message}`,
      ),
      'ext/read_dispatch_conversation',
      undefined,
      { code: -32000, message: 'conversation file is corrupt' },
    )
    expect(result).toBe('rejected: conversation file is corrupt')
  })

  it('surfaces a steer that raced completion with its terminal entry', async () => {
    const terminal = {
      dispatchId: 'd-1', name: 'worker', status: 'done', exitCode: 0, depth: 1,
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', durationMs: 1000, toolCount: 2,
    }
    const result = await runTool(
      (ctx) => ctx.steerDispatch('d-1', 'too late'),
      'ext/steer_dispatch',
      { delivered: false, outcome: 'completed', terminal },
    )
    expect(result).toEqual({ delivered: false, outcome: 'completed', terminal })
  })

  it('turns an unauthorized recall error into a typed outcome', async () => {
    const result = await runTool(
      (ctx) => ctx.recallDispatchWithOutcome('d-sibling', { reason: 'stop' }),
      'ext/recall_dispatch',
      undefined,
      { code: -32000, message: 'not yours', data: { outcome: 'unauthorized' } },
    )
    expect(result).toEqual({ found: false, outcome: 'unauthorized' })
  })

  it('still rejects recallDispatch for an unauthorized target', async () => {
    const result = await runTool(
      async (ctx) => {
        try {
          await ctx.recallDispatch('d-sibling')
          return 'resolved'
        } catch (err) {
          return `rejected: ${(err as Error).message}`
        }
      },
      'ext/recall_dispatch',
      undefined,
      { code: -32000, message: 'not yours', data: { outcome: 'unauthorized' } },
    )
    expect(result).toBe('rejected: not yours')
  })
})
