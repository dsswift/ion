import { afterEach, describe, expect, it, vi } from 'vitest'

// Pins the TypeScript SDK side of ambiguous name resolution and terminal
// dispatch history: the fields the engine answers with must reach the caller.

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
// and answers the first request for `method` with `response`. Resolves with
// the tool's JSON-encoded content.
async function runTool(
  body: (ctx: import('../../../../engine/extensions/sdk/ion-sdk/types').IonContext) => Promise<unknown>,
  method: string,
  response: unknown,
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
  line!(JSON.stringify({ jsonrpc: '2.0', id: call!.id, result: response }))
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
})
