/**
 * The direct conversation-file readers fill each tool row with its result.
 *
 * Both file formats persist a tool's output as a `tool_result` content block
 * on the following user message. The readers matched a renamed block type
 * that no file contains, so every tool row reloaded with empty output.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'ion-session-meta-tool-result-'))

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => root,
}))
vi.mock('../protocol/tabs-index', () => ({ principalSubjectForConversation: vi.fn(() => undefined) }))
vi.mock('../engine/engine-bridge-fs', () => ({ peekEngineHostInfo: vi.fn(() => undefined) }))

let previousDataDir: string | undefined
beforeAll(() => {
  previousDataDir = process.env.ION_DATA_DIR
  process.env.ION_DATA_DIR = root
})
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.ts\nb.ts' }

function lines(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

describe('session-meta tool results', () => {
  it('fills the tool row from an engine conversation file', async () => {
    const dir = join(root, 'conversations')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'conv-1.jsonl'), lines([
      { type: 'message', timestamp: 1, data: { role: 'assistant', content: [toolUse] } },
      { type: 'message', timestamp: 2, data: { role: 'user', content: [toolResult] } },
    ]))

    const { loadEngineConversationMessages } = await import('../session-meta')
    const tool = loadEngineConversationMessages('conv-1').find((m) => m.role === 'tool')
    expect(tool).toMatchObject({ toolId: 'toolu_1', content: 'a.ts\nb.ts' })
  })

  it('fills the tool row from a Claude session file', async () => {
    const dir = join(root, '.claude', 'projects', 'proj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-1.jsonl'), lines([
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [toolUse] } },
      { type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: [toolResult] } },
    ]))

    const { loadClaudeSessionMessages } = await import('../session-meta')
    const tool = loadClaudeSessionMessages('sess-1', undefined, 'proj').find((m) => m.role === 'tool')
    expect(tool).toMatchObject({ toolId: 'toolu_1', content: 'a.ts\nb.ts' })
  })
})
