/**
 * Pure pagination tests for tabs-session-chain (the engine-sourced
 * desktop_load_conversation path).
 *
 * With canonical engine row ids, cursors are stable across loads and desktop
 * restarts — two independent paginations over the same transcript walk the
 * same pages. The snap keeps turns whole; the cap bounds the frame.
 */

import { describe, it, expect, vi } from 'vitest'

const mockState = vi.hoisted(() => ({ rendererSnapshotCache: null as null | { tabs: Array<Record<string, unknown>> } }))

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
}))
vi.mock('../../../logger', () => ({ log: vi.fn() }))
vi.mock('../../../state', () => ({ state: mockState }))
vi.mock('../../../settings-store', () => ({ tabsFile: () => '/tmp/ion-nonexistent/tabs.json'}))

import { paginateHistory, resolveTabSessionChain, MAX_PAGE_MESSAGES, BULK_PAGE_MESSAGES, HISTORY_PAGE_BYTE_BUDGET } from '../tabs-session-chain'
import type { Message } from '@ion/shared/types'

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

describe('resolveTabSessionChain', () => {
  it('uses the renderer snapshot cache with canonical dedupe', async () => {
    mockState.rendererSnapshotCache = {
      tabs: [{ id: 'tab-live', status: 'running', conversationId: 'current', sessionIds: ['old', 'current', 'current'] }],
    }
    await expect(resolveTabSessionChain('tab-live')).resolves.toEqual({
      sessionIds: ['old', 'current'], tabStatus: 'running', conversationId: 'current', source: 'renderer_cache',
    })
    mockState.rendererSnapshotCache = null
  })
})

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


describe('paginateHistory byte ceiling', () => {
  // A page of heavy rows overflowed the connection's send cap on row count
  // alone, and the socket was closed mid-write. The page is now cut by bytes
  // too, from the oldest end, and the cut rows are the next older page.
  it('drops the oldest rows once the page passes the byte budget', () => {
    const big = 'x'.repeat(Math.ceil(HISTORY_PAGE_BYTE_BUDGET / 8))
    const all: Message[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: big, timestamp: i }))
    const { page, hasMore, cursor } = paginateHistory(all, undefined, BULK_PAGE_MESSAGES)
    const bytes = page.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0)
    expect(bytes).toBeLessThanOrEqual(HISTORY_PAGE_BYTE_BUDGET)
    expect(page.length).toBeGreaterThan(0)
    expect(page[page.length - 1].id).toBe('m39')
    expect(hasMore).toBe(true)
    expect(cursor).toBe(page[0].id)
  })

  it('still sends one row larger than the whole budget', () => {
    const huge = 'y'.repeat(HISTORY_PAGE_BYTE_BUDGET + 10)
    const { page } = paginateHistory([{ id: 'only', role: 'assistant', content: huge, timestamp: 0 }], undefined, BULK_PAGE_MESSAGES)
    expect(page).toHaveLength(1)
  })
})

describe('paginateHistory — bulk pages', () => {
  function transcript(count: number): Message[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      // Alternate so turn-snapping has real boundaries to find.
      role: i % 4 === 0 ? 'user' : 'assistant',
      content: `row ${i}`,
      timestamp: 1000 + i,
    })) as Message[]
  }

  it('returns the small default page when no size is requested', () => {
    // First paint must stay fast; this is the behavior every existing caller
    // relies on.
    const { page, hasMore } = paginateHistory(transcript(500))
    expect(page.length).toBeLessThanOrEqual(MAX_PAGE_MESSAGES)
    expect(page.length).toBeLessThan(50)
    expect(hasMore).toBe(true)
  })

  it('returns far more rows when a bulk size is requested', () => {
    const { page } = paginateHistory(transcript(1993), undefined, BULK_PAGE_MESSAGES)
    expect(page.length).toBe(1993)
  })

  it('completes a real-sized conversation in one bulk page', () => {
    // 1993 rows is the measured size of the conversation that exposed the
    // defect. One request, not two hundred.
    const { hasMore } = paginateHistory(transcript(1993), undefined, BULK_PAGE_MESSAGES)
    expect(hasMore).toBe(false)
  })

  it('caps a bulk page at BULK_PAGE_MESSAGES and reports more', () => {
    // A conversation larger than one frame's worth still paginates — the
    // client loops, but in single-digit iterations.
    const { page, hasMore, cursor } = paginateHistory(
      transcript(BULK_PAGE_MESSAGES + 500),
      undefined,
      BULK_PAGE_MESSAGES,
    )
    expect(page.length).toBe(BULK_PAGE_MESSAGES)
    expect(hasMore).toBe(true)
    expect(cursor).toBeDefined()
  })

  it('walks the remainder from the bulk cursor', () => {
    const all = transcript(BULK_PAGE_MESSAGES + 500)
    const first = paginateHistory(all, undefined, BULK_PAGE_MESSAGES)
    const second = paginateHistory(all, first.cursor, BULK_PAGE_MESSAGES)

    expect(second.hasMore).toBe(false)
    // The two pages together cover the transcript with no gap: the second
    // page ends exactly where the first begins.
    expect(second.page[second.page.length - 1]!.id).toBe(
      all[all.findIndex((m) => m.id === first.cursor) - 1]!.id,
    )
  })

  it('keeps the default page bounded even when a turn snap would overshoot', () => {
    // A long assistant run with no user boundary must not turn a default page
    // into an unbounded one.
    const all = Array.from({ length: 400 }, (_, i) => ({
      id: `m${i}`,
      role: i === 0 ? 'user' : 'assistant',
      content: `row ${i}`,
      timestamp: 1000 + i,
    })) as Message[]

    const { page } = paginateHistory(all)
    expect(page.length).toBeLessThanOrEqual(MAX_PAGE_MESSAGES)
  })
})
