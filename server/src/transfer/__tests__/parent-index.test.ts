/**
 * The parent index reads each conversation's header once. Pinned: a family
 * is found through it, a conversation added later is picked up, one removed
 * is dropped, and a header still being written is retried rather than
 * remembered as parentless.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parentIndex, _resetParentIndexForTest } from '../parent-index'
import { collectFamily } from '../collect-family'

const dirs: string[] = []
afterEach(() => {
  _resetParentIndexForTest()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function conversationsDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ion-parent-index-'))
  dirs.push(d)
  return d
}
function writeConversation(dir: string, id: string, parentId?: string): void {
  writeFileSync(join(dir, `${id}.llm.jsonl`), `${JSON.stringify({ meta: true, id, system: 'x'.repeat(40_000), ...(parentId ? { parentId } : {}) })}\n{"role":"user"}\n`)
}

describe('parentIndex', () => {
  it('finds a family, then picks up a later fork and drops a removed one', async () => {
    const dir = conversationsDir()
    writeConversation(dir, 'root')
    writeConversation(dir, 'child', 'root')
    writeConversation(dir, 'other')
    expect((await collectFamily('root', dir)).ids.sort()).toEqual(['child', 'root'])

    writeConversation(dir, 'grandchild', 'child')
    rmSync(join(dir, 'other.llm.jsonl'))
    const index = await parentIndex(dir)
    expect(index.get('grandchild')?.parentId).toBe('child')
    expect(index.has('other')).toBe(false)
    expect((await collectFamily('root', dir)).ids.sort()).toEqual(['child', 'grandchild', 'root'])
  })

  it('retries a header that is still being written', async () => {
    const dir = conversationsDir()
    writeFileSync(join(dir, 'forming.llm.jsonl'), '{"meta":true,"id":"forming","parentId":"ro')
    expect((await parentIndex(dir)).has('forming')).toBe(false)
    writeConversation(dir, 'forming', 'root')
    expect((await parentIndex(dir)).get('forming')?.parentId).toBe('root')
  })
})
