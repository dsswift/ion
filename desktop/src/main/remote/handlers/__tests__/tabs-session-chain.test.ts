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
vi.mock('../../../settings-store', () => ({ TABS_FILE: '/tmp/ion-nonexistent/tabs.json' }))

import { paginateHistory, planPathFromHistory, resolvePlanPath, resolveTabSessionChain, toRemoteMessage, MAX_PAGE_MESSAGES, BULK_PAGE_MESSAGES } from '../tabs-session-chain'
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


describe('toRemoteMessage', () => {
  it('preserves plan implementation provenance in iOS history rows', () => {
    const remote = toRemoteMessage(msg('u-implementation', 'user', {
      content: 'Implement the plan.',
      implementationPhase: true,
    }))

    expect(remote).toMatchObject({
      id: 'u-implementation',
      implementationPhase: true,
    })
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

/**
 * resolvePlanPath reports WHERE an ExitPlanMode row's plan path came from.
 *
 * A conversation loaded with an unresolvable plan and the desktop logged "no
 * plan file found for ExitPlanMode" carrying neither a tab id nor a path.
 * Asked which conversation it was, the log could not answer: a reconnect loads
 * every conversation at once and the enrichment awaits inside a Promise.all
 * map, so the lines interleave and timestamp correlation attributes nothing.
 *
 * The source is half of the fix. These two failures log the same message and
 * need opposite responses:
 *
 *   'tool_input' / 'history_write' — a path resolved, and the READ failed:
 *       look at the filesystem.
 *   'none' — no path resolved, so no read was attempted: look at the
 *       transcript, which carries no plan path at all.
 *
 * The observed case was 'none' (the log had no path field because planPath was
 * undefined), which reads as a missing file unless the source says otherwise.
 */
describe('resolvePlanPath', () => {
  const planWrite = (path: string) =>
    msg('w1', 'tool', { toolName: 'Write', toolInput: JSON.stringify({ file_path: path }) })

  it('attributes a path carried on the tool call', () => {
    expect(resolvePlanPath('/Users/x/.ion/plans/a.md', [])).toEqual({
      planPath: '/Users/x/.ion/plans/a.md', pathSource: 'tool_input',
    })
  })

  it('attributes a path recovered from a transcript Write', () => {
    expect(resolvePlanPath(undefined, [planWrite('/Users/x/.ion/plans/b.md')])).toEqual({
      planPath: '/Users/x/.ion/plans/b.md', pathSource: 'history_write',
    })
  })

  it('reports none when neither source yields a path', () => {
    expect(resolvePlanPath(undefined, [msg('u0', 'user')])).toEqual({
      planPath: undefined, pathSource: 'none',
    })
  })

  it('prefers the tool call over the transcript when both exist', () => {
    // The tool call names the plan THIS proposal refers to; a later unrelated
    // plan Write in the same transcript must not override it.
    expect(resolvePlanPath('/Users/x/.ion/plans/proposed.md', [planWrite('/Users/x/.ion/plans/other.md')])).toEqual({
      planPath: '/Users/x/.ion/plans/proposed.md', pathSource: 'tool_input',
    })
  })

  it('treats an empty tool-call path as absent rather than as a path', () => {
    // '' would otherwise reach readFile and throw a confusing error instead of
    // taking the honest fallback.
    expect(resolvePlanPath('', [planWrite('/Users/x/.ion/plans/c.md')])).toEqual({
      planPath: '/Users/x/.ion/plans/c.md', pathSource: 'history_write',
    })
  })

  it('treats a non-string tool-call path as absent', () => {
    // toolInput is parsed JSON from the wire, so the field is unknown until
    // checked; a number must not be handed to readFile.
    expect(resolvePlanPath(42, [])).toEqual({ planPath: undefined, pathSource: 'none' })
  })
})

/**
 * Bulk pagination.
 *
 * THE DEFECT THIS EXISTS FOR: the default page is 10 rows, snapped to a turn
 * boundary. That is right for first paint and badly wrong for loading a whole
 * conversation — a measured 1993-row transcript took ~200 round trips at that
 * size, and every response rebuilt the client's transcript, producing seconds
 * of continuous flicker.
 *
 * A measured transcript averages ~1.3 KB per row on the wire after the
 * tool-content cap, and the relay caps a frame at 12 MB, so the remainder of a
 * real conversation fits in ONE bulk page. A client that needs the whole
 * transcript asks for one instead of walking.
 */
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
