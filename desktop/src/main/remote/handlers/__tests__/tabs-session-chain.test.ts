/**
 * Pure pagination tests for tabs-session-chain (the engine-sourced
 * desktop_load_conversation path).
 *
 * With canonical engine row ids, cursors are stable across loads and desktop
 * restarts — two independent paginations over the same transcript walk the
 * same pages. The snap keeps turns whole; the cap bounds the frame.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
}))
vi.mock('../../../logger', () => ({ log: vi.fn() }))
vi.mock('../../../state', () => ({ state: {} }))
vi.mock('../../../settings-store', () => ({ TABS_FILE: '/tmp/ion-nonexistent/tabs.json' }))

import { paginateHistory, planPathFromHistory, MAX_PAGE_MESSAGES } from '../tabs-session-chain'
import type { Message } from '../../../../shared/types'

function msg(id: string, role: Message['role'], extra: Partial<Message> = {}): Message {
  return { id, role, content: `c-${id}`, timestamp: 1, ...extra }
}

/** A transcript of N turns: user + assistant per turn. */
function turns(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push(msg(`u${i}`, 'user'))
    out.push(msg(`a${i}`, 'assistant'))
  }
  return out
}

describe('paginateHistory', () => {
  it('serves the last page snapped to a user turn, with a cursor', () => {
    const all = turns(20) // 40 rows
    const { page, hasMore, cursor } = paginateHistory(all)
    expect(page[0].role).toBe('user') // snap
    expect(page[page.length - 1].id).toBe('a19')
    expect(hasMore).toBe(true)
    expect(cursor).toBe(page[0].id)
  })

  it('cursor pagination walks identical pages across two independent loads', () => {
    const collect = (all: Message[]) => {
      const pages: string[][] = []
      let before: string | undefined
      for (let guard = 0; guard < 50; guard++) {
        const r = paginateHistory(all, before)
        pages.push(r.page.map((m) => m.id))
        if (!r.hasMore) break
        before = r.cursor
      }
      return pages
    }
    // Two loads (e.g. across a desktop restart — engine ids are stable).
    const p1 = collect(turns(25))
    const p2 = collect(turns(25))
    expect(p1).toEqual(p2)
    // Full coverage, no overlap.
    const flat = p1.flat()
    expect(new Set(flat).size).toBe(flat.length)
    expect(flat.length).toBe(50)
  })

  it('caps an oversized single turn at MAX_PAGE_MESSAGES and keeps hasMore', () => {
    const all: Message[] = [msg('u0', 'user')]
    for (let i = 0; i < MAX_PAGE_MESSAGES + 40; i++) {
      all.push(msg(`t${i}`, 'tool', { toolName: 'Bash', toolId: `toolu_${i}` }))
    }
    const { page, hasMore } = paginateHistory(all)
    expect(page.length).toBe(MAX_PAGE_MESSAGES)
    expect(hasMore).toBe(true)
  })

  it('truncates oversized tool content on the page copy only', () => {
    const big = 'x'.repeat(5000)
    const all = [msg('u0', 'user'), msg('t0', 'tool', { toolName: 'Bash', toolId: 'toolu_0', content: big })]
    const { page } = paginateHistory(all)
    const tool = page.find((m) => m.id === 't0')!
    expect(tool.content.length).toBeLessThan(3000)
    expect(tool.content.endsWith('[truncated]')).toBe(true)
    // Source list untouched.
    expect(all[1].content.length).toBe(5000)
  })

  it('unknown cursor falls back to the last page', () => {
    const all = turns(5)
    const r = paginateHistory(all, 'no-such-id')
    expect(r.page[r.page.length - 1].id).toBe('a4')
  })
})

describe('planPathFromHistory', () => {
  it('finds the most recent plan-file Write', () => {
    const all = [
      msg('w1', 'tool', { toolName: 'Write', toolInput: JSON.stringify({ file_path: '/Users/x/.ion/plans/old.md' }) }),
      msg('w2', 'tool', { toolName: 'Write', toolInput: JSON.stringify({ file_path: '/tmp/not-a-plan.md' }) }),
      msg('w3', 'tool', { toolName: 'Write', toolInput: JSON.stringify({ file_path: '/Users/x/.ion/plans/new.md' }) }),
    ]
    expect(planPathFromHistory(all)).toBe('/Users/x/.ion/plans/new.md')
  })

  it('returns undefined when no plan write exists', () => {
    expect(planPathFromHistory([msg('u0', 'user')])).toBeUndefined()
  })
})
