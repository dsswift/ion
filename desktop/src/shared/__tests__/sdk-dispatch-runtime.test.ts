import { afterEach, describe, expect, it, vi } from 'vitest'

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

const originalConsole = { ...console }

afterEach(() => {
  Object.assign(console, originalConsole)
  lineHandlers.length = 0
  vi.restoreAllMocks()
  vi.resetModules()
})

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('TypeScript SDK asynchronous dispatch routing', () => {
  it('delivers a terminal notification that arrives before its stub response', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
    const ion = runtime.createIon()
    let completions = 0
    let staleLifecycleCalls = 0
    ion.registerTool({
      name: 'launch',
      description: 'launch child',
      parameters: {},
      execute: async (_params, ctx) => {
        const result = await ctx.dispatchAgent({
          name: 'worker',
          task: 'finish quickly',
          onComplete: () => { completions++ },
          onTextDelta: () => { staleLifecycleCalls++ },
        })
        return { content: result.dispatchId ?? '', isError: false }
      },
    })
    await nextTurn()
    const line = lineHandlers.at(-1)
    expect(line).toBeDefined()

    line!('{"jsonrpc":"2.0","id":1,"method":"tool/launch","params":{"_ctx":{}}}')
    await nextTurn()
    const dispatch = writes
      .map((write) => JSON.parse(write))
      .find((frame) => frame.method === 'ext/dispatch_agent')
    expect(dispatch).toBeDefined()

    // Completion wins the race against the RPC response. Name-keyed terminal
    // handlers must consume it before the dispatch ID is available.
    line!('{"jsonrpc":"2.0","method":"dispatch_complete","params":{"name":"worker","dispatchId":"dispatch-fast","output":"done","exitCode":0}}')
    line!(`{"jsonrpc":"2.0","id":${dispatch.id},"result":{"dispatchId":"dispatch-fast"}}`)
    await nextTurn()
    await nextTurn()

    expect(completions).toBe(1)
    line!('{"jsonrpc":"2.0","method":"dispatch_text_delta","params":{"name":"worker","dispatchId":"dispatch-fast","delta":"late","accumulated":"late"}}')
    expect(staleLifecycleCalls).toBe(0)
  })
})
