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

/**
 * Runs one tool whose execute() reads ctx.applicationConfig, answers the
 * engine RPC it issues with `answer`, and returns the RPC request the SDK
 * sent plus the tool's result.
 */
async function runRead(
  read: (ctx: import('../../../../engine/extensions/sdk/ion-sdk/types').IonContext) => Promise<unknown>,
  method: string,
  answer: Record<string, unknown>,
): Promise<{ params: Record<string, unknown>; result: unknown }> {
  const writes: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)

  const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
  const ion = runtime.createIon()
  ion.registerTool({
    name: 'reader',
    description: 'reads application config',
    parameters: {},
    execute: async (_params, ctx) => ({ content: JSON.stringify(await read(ctx)) }),
  })
  await nextTurn()
  const line = lineHandlers.at(-1)!
  line('{"jsonrpc":"2.0","id":1,"method":"tool/reader","params":{"_ctx":{}}}')
  await nextTurn()
  const request = writes.map((write) => JSON.parse(write)).find((frame) => frame.method === method)
  expect(request, `the SDK must issue ${method}`).toBeDefined()
  line(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: answer }))
  await nextTurn()
  const response = writes.map((write) => JSON.parse(write)).find((frame) => frame.id === 1)
  return { params: request.params, result: JSON.parse(response.result.content) }
}

describe('TypeScript SDK applicationConfig', () => {
  it('keeps not-ready distinct from a missing key', async () => {
    const notReady = await runRead((ctx) => ctx.applicationConfig.get('region'), 'ext/get_application_config',
      { state: 'fetching', revision: 1, key: 'region', found: false })
    expect(notReady.params).toEqual({ key: 'region' })
    expect(notReady.result).toEqual({ state: 'fetching', revision: 1, key: 'region', found: false })

    vi.resetModules()
    lineHandlers.length = 0
    const missing = await runRead((ctx) => ctx.applicationConfig.get('region'), 'ext/get_application_config',
      { state: 'ready', revision: 2, key: 'region', found: false })
    expect(missing.result).toEqual({ state: 'ready', revision: 2, key: 'region', found: false })
  })

  it('returns the whole snapshot', async () => {
    const { params, result } = await runRead((ctx) => ctx.applicationConfig.snapshot(), 'ext/get_application_config',
      { state: 'ready', revision: 3, subject: 'subject-a', values: { region: 'east' }, fetchedAt: '2026-09-29T00:00:00Z' })
    expect(params).toEqual({})
    expect(result).toEqual({ state: 'ready', revision: 3, subject: 'subject-a', values: { region: 'east' }, fetchedAt: '2026-09-29T00:00:00Z' })
  })

  it('awaits with a timeout and reports timedOut', async () => {
    const { params, result } = await runRead((ctx) => ctx.applicationConfig.await({ timeoutMs: 1500 }),
      'ext/await_application_config', { state: 'deferred', revision: 0, timedOut: true })
    expect(params).toEqual({ timeoutMs: 1500 })
    expect(result).toEqual({ state: 'deferred', revision: 0, timedOut: true })
  })
})
