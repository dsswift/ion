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

describe('TypeScript SDK callTool typed content', () => {
  it('preserves embedded MCP blobs without decoding them', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    const runtime = await import('../../../../engine/extensions/sdk/ion-sdk/runtime')
    const ion = runtime.createIon()
    ion.registerTool({
      name: 'nested',
      description: 'calls MCP',
      parameters: {},
      execute: async (_params, ctx) => ctx.callTool('mcp__example__resource', {}),
    })
    await nextTurn()
    const line = lineHandlers.at(-1)
    expect(line).toBeDefined()

    line!('{"jsonrpc":"2.0","id":1,"method":"tool/nested","params":{"_ctx":{}}}')
    await nextTurn()
    const request = writes.map((write) => JSON.parse(write)).find((frame) => frame.method === 'ext/call_tool')
    expect(request).toBeDefined()

    line!(`{"jsonrpc":"2.0","id":${request.id},"result":{"content":"attachment.bin, 4 bytes","contentItems":[{"type":"resource","resource":{"uri":"attachment://example","mimeType":"application/octet-stream","blob":"AAECAw=="}}]}}`)
    await nextTurn()

    const response = writes.map((write) => JSON.parse(write)).find((frame) => frame.id === 1)
    expect(response.result).toEqual({
      content: 'attachment.bin, 4 bytes',
      isError: false,
      contentItems: [{
        type: 'resource',
        resource: { uri: 'attachment://example', mimeType: 'application/octet-stream', blob: 'AAECAw==' },
      }],
    })
  })
})
