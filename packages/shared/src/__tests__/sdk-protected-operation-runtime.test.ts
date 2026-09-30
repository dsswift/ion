import { afterEach, describe, expect, it, vi } from 'vitest'

const { lineHandlers } = vi.hoisted(() => ({
  lineHandlers: [] as Array<(line: string) => void>,
}))

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === 'line') lineHandlers.push(handler)
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

describe('TypeScript SDK protectedOperation', () => {
  it('sends only the operation name and payload and returns the engine result', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
    const ion = runtime.createIon()
    ion.registerTool({
      name: 'publish',
      description: 'publishes a metric',
      parameters: {},
      execute: async (_params, ctx) => {
        const res = await ctx.protectedOperation('publish-metric', { value: 42 })
        return { content: `${res.status} ${res.body} ${res.headers['X-Echo-Key']}` }
      },
    })
    await nextTurn()
    const line = lineHandlers.at(-1)
    expect(line).toBeDefined()

    line!('{"jsonrpc":"2.0","id":1,"method":"tool/publish","params":{"_ctx":{}}}')
    await nextTurn()
    const request = writes.map((write) => JSON.parse(write)).find((frame) => frame.method === 'ext/protected_operation')
    expect(request).toBeDefined()
    expect(request.params).toEqual({ name: 'publish-metric', payload: { value: 42 } })

    line!(`{"jsonrpc":"2.0","id":${request.id},"result":{"status":202,"headers":{"X-Echo-Key":"[redacted]"},"body":"ok"}}`)
    await nextTurn()

    const response = writes.map((write) => JSON.parse(write)).find((frame) => frame.id === 1)
    expect(response.result.content).toBe('202 ok [redacted]')
  })
})
