/**
 * session-meta-images.test.ts
 *
 * Regression test for #224: loadEngineConversationMessages (the direct engine
 * conversation reader used when the session-plane RPC is unavailable) must
 * replay persisted tool-result image blocks onto their owning tool row, the
 * same way the engine's flattenEntries does. Before the fix, image blocks in
 * the persisted user turn were silently dropped.
 *
 * The loader reads from {homedir}/.ion/conversations/{id}.jsonl and the image
 * saver writes under the same root; os.homedir() honors $HOME on posix, so we
 * point HOME at a temp dir to isolate the test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadEngineConversationMessages } from '../session-meta'

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

let testHome: string
let convDir: string
let originalHome: string | undefined

beforeEach(() => {
  testHome = join(tmpdir(), `session-meta-img-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  convDir = join(testHome, '.ion', 'conversations')
  mkdirSync(convDir, { recursive: true })
  originalHome = process.env.HOME
  process.env.HOME = testHome
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
})

/** Write a legacy-unified `.jsonl` conversation (header + `message` entries). */
function writeConversation(id: string, entries: any[]): void {
  const lines = [
    JSON.stringify({ meta: true, id, version: 2 }),
    ...entries.map((e) => JSON.stringify({ type: 'message', id: e.id, timestamp: e.ts, data: { role: e.role, content: e.content } })),
  ]
  writeFileSync(join(convDir, `${id}.jsonl`), lines.join('\n'))
}

describe('loadEngineConversationMessages — image attachments (#224)', () => {
  it('attaches a persisted image block to its owning tool row by tool_use_id', () => {
    // Revert-check: remove the `block.type === 'image'` arm in
    // loadEngineConversationMessages and the attachment assertion goes red.
    writeConversation('conv-img', [
      { id: 'u1', role: 'user', content: 'screenshot', ts: 1 },
      { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a', name: 'Screenshot', input: {} }], ts: 2 },
      {
        id: 'r1',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_a', content: '[Image: shot]' },
          { type: 'image', tool_use_id: 'tu_a', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        ],
        ts: 3,
      },
    ])
    const msgs = loadEngineConversationMessages('conv-img')
    const toolRow = msgs.find((m) => m.role === 'tool')
    expect(toolRow).toBeDefined()
    expect(toolRow.toolId).toBe('tu_a')
    expect(toolRow.attachments).toHaveLength(1)
    expect(toolRow.attachments[0].type).toBe('image')
    expect(toolRow.attachments[0].path).toContain(join('conv-img', 'images'))
    expect(toolRow.attachments[0].path).not.toContain(PNG_B64)
    expect(existsSync(toolRow.attachments[0].path)).toBe(true)
  })

  it('attaches a legacy empty-id image to the most recent tool row', () => {
    writeConversation('conv-legacy', [
      { id: 'u1', role: 'user', content: 'two shots', ts: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'Screenshot', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'Screenshot', input: {} },
        ],
        ts: 2,
      },
      {
        id: 'r1',
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_a', content: '[Image: A]' },
          { type: 'tool_result', tool_use_id: 'tu_b', content: '[Image: B]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        ],
        ts: 3,
      },
    ])
    const msgs = loadEngineConversationMessages('conv-legacy')
    const toolRows = msgs.filter((m) => m.role === 'tool')
    expect(toolRows).toHaveLength(2)
    const rowA = toolRows.find((m) => m.toolId === 'tu_a')
    const rowB = toolRows.find((m) => m.toolId === 'tu_b')
    expect(rowA.attachments ?? []).toHaveLength(0)
    expect(rowB.attachments).toHaveLength(1)
  })
})
