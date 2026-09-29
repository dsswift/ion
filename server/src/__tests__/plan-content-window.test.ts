import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readPlanWindow, utf8SafeEnd, utf8Window, PLAN_WINDOW_MAX_BYTES } from '../plan-content-window'
import { useSessionStore } from '../store/sessionStore'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-plan-window-'))
  useSessionStore.setState({ conversationPanes: new Map() as never })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Pages a plan the way a client does: append each window, ask again at offset + byteLength(text). */
function assemble(planFilePath: string, length: number): { text: string; pages: number } {
  let text = ''
  let offset = 0
  let pages = 0
  for (;;) {
    const win = readPlanWindow({ planFilePath, offset, length })
    text += win.content
    pages++
    if (!win.hasMore) return { text, pages }
    offset += Buffer.byteLength(win.content, 'utf-8')
    if (pages > 10_000) throw new Error('paging did not terminate')
  }
}

describe('utf8SafeEnd', () => {
  it('backs off a cut that lands inside a multi-byte character', () => {
    const buf = Buffer.from('a—b', 'utf-8') // 'a' + 3-byte em dash + 'b'
    expect(utf8SafeEnd(buf, 1)).toBe(1)
    expect(utf8SafeEnd(buf, 2)).toBe(1)
    expect(utf8SafeEnd(buf, 3)).toBe(1)
    expect(utf8SafeEnd(buf, 4)).toBe(4)
    expect(utf8SafeEnd(buf, 99)).toBe(5)
  })

  it('never decodes a partial character into a replacement', () => {
    const buf = Buffer.from('—'.repeat(10), 'utf-8')
    for (let n = 0; n <= buf.length; n++) expect(utf8Window(buf, 0, n).text).not.toContain('�')
  })
})

describe('readPlanWindow', () => {
  // The bug this pins: a window cut at a raw byte offset ends mid-character,
  // decodes its tail to U+FFFD, and the client's next offset (computed from
  // the text it received) is then wrong for every page after it.
  it('reassembles a plan full of multi-byte characters exactly, at a page size that splits them', () => {
    const plan = 'Step one — do the thing.\nÉtape deux: naïve café ☕ déjà vu.\n'.repeat(40)
    const path = join(dir, 'plan.md')
    writeFileSync(path, plan)
    const { text, pages } = assemble(path, 17)
    expect(text).toBe(plan)
    expect(text).not.toContain('�')
    expect(pages).toBeGreaterThan(10)
  })

  it('reports the whole size, and that more remains, on a first window', () => {
    const path = join(dir, 'plan.md')
    writeFileSync(path, 'x'.repeat(1000))
    expect(readPlanWindow({ planFilePath: path, length: 100 })).toEqual({ content: 'x'.repeat(100), offset: 0, totalBytes: 1000, hasMore: true, source: 'disk' })
    expect(readPlanWindow({ planFilePath: path, offset: 900, length: 100 })).toMatchObject({ hasMore: false, totalBytes: 1000 })
  })

  it('clamps a window to the maximum, whatever was asked for', () => {
    const path = join(dir, 'plan.md')
    writeFileSync(path, 'x'.repeat(PLAN_WINDOW_MAX_BYTES * 2))
    expect(readPlanWindow({ planFilePath: path, length: PLAN_WINDOW_MAX_BYTES * 10 }).content.length).toBe(PLAN_WINDOW_MAX_BYTES)
    expect(readPlanWindow({ planFilePath: path }).content.length).toBe(PLAN_WINDOW_MAX_BYTES)
  })

  it('answers a plan that does not exist with an empty window, not an error', () => {
    expect(readPlanWindow({ planFilePath: join(dir, 'absent.md') })).toEqual({ content: '', offset: 0, totalBytes: 0, hasMore: false, source: 'none' })
    expect(readPlanWindow({ planFilePath: '' })).toMatchObject({ source: 'none' })
  })

  it('prefers the plan the store holds for the pending question over the file', () => {
    const path = join(dir, 'plan.md')
    writeFileSync(path, 'stale on disk')
    useSessionStore.setState({
      conversationPanes: new Map([
        ['tab-1', { activeInstanceId: 'i1', instances: [{ id: 'i1', messages: [], permissionQueue: [{ questionId: 'q-1', toolInput: { planContent: 'fresh from the engine' } }] }] }],
      ]) as never,
    })
    expect(readPlanWindow({ planFilePath: path, questionId: 'q-1' })).toMatchObject({ content: 'fresh from the engine', source: 'store' })
    expect(readPlanWindow({ planFilePath: path, questionId: 'q-other' })).toMatchObject({ content: 'stale on disk', source: 'disk' })
  })
})
