import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Pins the TypeScript SDK side of conversation record access: the record path
// the engine supplies on the context, the read call's wire shape, and the
// record row type's field-for-field match with the engine's row.

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

type IonContext = import('../../../../engine/extensions/sdk/ion-sdk/types').IonContext
type Frame = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: { content: string; isError: boolean }
}
type Reply = { result: unknown } | { error: { code: number; message: string } }

// runTool starts the SDK, registers one tool whose body is `body`, and invokes
// it with `ctxData` as its `_ctx`. When `answer` is given, the first request
// for its method is answered with its reply. Resolves with the engine-bound
// request (if any) and the tool's result.
async function runTool(
  ctxData: Record<string, unknown>,
  body: (ctx: IonContext) => Promise<unknown>,
  answer?: { method: string; reply: Reply },
): Promise<{ call?: Frame; content: string; isError: boolean }> {
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
        return { content: JSON.stringify(await body(ctx)), isError: false }
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  })
  await nextTurn()
  const line = lineHandlers.at(-1)
  expect(line).toBeDefined()

  line!(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tool/probe', params: { _ctx: ctxData } }))
  await nextTurn()
  const frames = (): Frame[] => writes.map((write) => JSON.parse(write) as Frame)
  let call: Frame | undefined
  if (answer) {
    call = frames().find((frame) => frame.method === answer.method)
    expect(call, `${answer.method} was not sent`).toBeDefined()
    line!(JSON.stringify({ jsonrpc: '2.0', id: call!.id, ...answer.reply }))
    await nextTurn()
    await nextTurn()
  }

  const reply = frames().find((frame) => frame.id === 1 && frame.result !== undefined)
  expect(reply, 'tool reply was not sent').toBeDefined()
  return { call, content: reply!.result!.content, isError: reply!.result!.isError }
}

describe('TypeScript SDK conversation record access', () => {
  it('exposes the record path the engine supplies', async () => {
    const path = '/data/conversations/conv-1.tree.jsonl'
    const { content } = await runTool(
      { conversationId: 'conv-1', conversationRecordPath: path },
      async (ctx) => ctx.conversationRecordPath,
    )
    expect(JSON.parse(content)).toBe(path)
  })

  it('leaves the record path empty when no conversation is active', async () => {
    const { content } = await runTool({}, async (ctx) => ctx.conversationRecordPath)
    expect(JSON.parse(content)).toBe('')
  })

  it('reads a record by id with paging and returns its timestamped turns', async () => {
    const record = {
      messages: [
        { id: 'e1', role: 'user', content: 'hi', timestamp: 1780093348767 },
        { id: 'e2', role: 'assistant', content: 'hello', timestamp: 1780093349000 },
      ],
      total: 9,
      hasMore: true,
    }
    const { call, content } = await runTool(
      {},
      (ctx) => ctx.conversations.read('conv-9', { offset: 3, limit: 2 }),
      { method: 'ext/read_conversation', reply: { result: record } },
    )
    expect(call!.params).toEqual({ conversationId: 'conv-9', offset: 3, limit: 2 })
    expect(JSON.parse(content)).toEqual(record)
  })

  it('asks for the whole record when no paging is given', async () => {
    const { call } = await runTool(
      {},
      (ctx) => ctx.conversations.read('conv-9'),
      { method: 'ext/read_conversation', reply: { result: { messages: [], total: 0, hasMore: false } } },
    )
    expect(call!.params).toEqual({ conversationId: 'conv-9', offset: 0, limit: 0 })
  })

  it('rejects when the engine refuses the read', async () => {
    const { content, isError } = await runTool(
      {},
      (ctx) => ctx.conversations.read('missing'),
      { method: 'ext/read_conversation', reply: { error: { code: -32000, message: 'conversation not found: missing' } } },
    )
    expect(isError).toBe(true)
    expect(content).toContain('conversation not found')
  })
})

describe('ConversationMessage mirrors the engine record row', () => {
  const manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../../../engine/internal/types/testdata/contracts.json'),
    'utf-8',
  )) as { sharedTypes: Record<string, string[]> }
  const typesPath = resolve(__dirname, '../../../../engine/extensions/sdk/ion-sdk/types-conversations.ts')
  const source = ts.createSourceFile(typesPath, readFileSync(typesPath, 'utf-8'), ts.ScriptTarget.Latest, true)

  function interfaceFields(name: string): string[] {
    const fields: string[] = []
    source.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node) || node.name.text !== name) return
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) fields.push(member.name.getText(source))
      }
    })
    return fields.sort()
  }

  it.each([
    ['ConversationMessage', 'SessionMessage'],
    ['ConversationMessageAttachment', 'SessionMessageAttachment'],
  ])('%s has exactly the fields of the engine %s', (sdkType, engineType) => {
    expect(interfaceFields(sdkType)).toEqual([...manifest.sharedTypes[engineType]].sort())
  })
})
