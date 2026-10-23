import { afterEach, describe, expect, it, vi } from 'vitest'

// The TS SDK's init handshake carries each tool's alwaysLoad mark, and omits
// it when unset, so the engine keeps only marked tools loaded under tool search.

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

describe('TypeScript SDK init handshake tools', () => {
  it('reports alwaysLoad only on the tools that set it', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    const runtime = await import('../ion-sdk/runtime')
    const ion = runtime.createIon()
    const execute = async () => ({ content: 'ok' })
    ion.registerTool({ name: 'core', description: 'core', parameters: { type: 'object' }, alwaysLoad: true, execute })
    ion.registerTool({ name: 'lazy', description: 'lazy', parameters: { type: 'object' }, execute })
    await nextTurn()

    lineHandlers.at(-1)!(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'init', params: { extensionDir: '', model: '', workingDirectory: '' } }))
    await nextTurn()

    const response = writes.map((w) => JSON.parse(w)).find((frame) => frame.id === 1)
    const tools = response.result.tools as Array<Record<string, unknown>>
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.core.alwaysLoad).toBe(true)
    expect('alwaysLoad' in byName.lazy).toBe(false)
  })
})
