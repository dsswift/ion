import { afterEach, describe, expect, it, vi } from 'vitest'

// Pins the TypeScript SDK side of the link integrity scan: the report the
// engine answers with reaches the caller, and a refused scan rejects instead
// of resolving to an empty report.

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

type Frame = { id?: number; method?: string; result?: unknown }
type RpcReply = { result: unknown } | { error: { code: number; message: string } }

// runScan starts the SDK, registers a tool that calls ctx.scanWikiLinks(),
// invokes it, and answers ext/scan_wiki_links with `reply`. Resolves with the
// tool's JSON-encoded content.
async function runScan(reply: RpcReply): Promise<unknown> {
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
    execute: async (_params, ctx) => {
      try {
        return { content: JSON.stringify({ report: await ctx.scanWikiLinks() }), isError: false }
      } catch (err) {
        return { content: JSON.stringify({ rejected: err instanceof Error ? err.message : String(err) }), isError: false }
      }
    },
  })
  await nextTurn()
  const line = lineHandlers.at(-1)
  expect(line).toBeDefined()

  line!('{"jsonrpc":"2.0","id":1,"method":"tool/probe","params":{"_ctx":{}}}')
  await nextTurn()
  const frames = (): Frame[] => writes.map((write) => JSON.parse(write) as Frame)
  const call = frames().find((frame) => frame.method === 'ext/scan_wiki_links')
  expect(call, 'ext/scan_wiki_links was not sent').toBeDefined()
  line!(JSON.stringify({ jsonrpc: '2.0', id: call!.id, ...reply }))
  await nextTurn()
  await nextTurn()

  const toolReply = frames().find((frame) => frame.id === 1 && frame.result !== undefined)
  expect(toolReply, 'tool reply was not sent').toBeDefined()
  return JSON.parse((toolReply!.result as { content: string }).content)
}

describe('TypeScript SDK wiki link integrity scan', () => {
  it('returns the integrity report from scanWikiLinks', async () => {
    const report = {
      root: '/work',
      documentsScanned: 3,
      linksChecked: 5,
      broken: [{ path: 'index.md', line: 4, link: '[[gone|label]]', target: 'gone', reason: 'missing' }],
    }
    expect(await runScan({ result: report })).toEqual({ report })
  })

  it('rejects when the engine refuses the scan', async () => {
    const result = (await runScan({
      error: { code: -32000, message: 'wiki link integrity scan is disabled' },
    })) as { rejected?: string; report?: unknown }
    expect(result.report).toBeUndefined()
    expect(result.rejected).toContain('wiki link integrity scan is disabled')
  })
})
