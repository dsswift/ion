/**
 * useTabRestoration-images — mergeHistoryAttachments regression tests
 *
 * Pins the #224 desktop resume fix: extension-hosted tabs restore from the
 * persisted desktop cache (which can carry zero image attachments) and never
 * call load_session_history, so their inline images vanish on restart. The
 * reconciler merges attachments from the engine's authoritative flattenEntries
 * history onto the matching restored tool rows (keyed by toolId, deduped by
 * on-disk path).
 *
 * Revert-test contract: a no-op merge (returning the input untouched) would
 * fail "attaches engine-history images onto attachment-less restored tool
 * rows" — the reported bug where a 20-image conversation restored with none.
 */

import { describe, it, expect, vi } from 'vitest'

// mergeHistoryAttachments is pure, but its module also exports the
// reconcile orchestrator, which imports the store (→ theme-tokens, which needs
// `document`). Mock the store deps so the pure-function tests don't drag in
// the DOM-bound module graph.
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../stores/conversation-instance', () => ({
  activeInstance: vi.fn(),
  commitInstance: vi.fn(),
}))
vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(),
  rWarn: vi.fn(),
}))

import { mergeHistoryAttachments } from '../useTabRestoration-images'
import type { Message, SessionLoadMessage } from '../../../shared/types'

function toolMsg(toolId: string, attachments?: Message['attachments']): Message {
  return {
    id: `m-${toolId}`,
    role: 'tool',
    content: '',
    toolName: 'Read',
    toolId,
    timestamp: 1,
    ...(attachments ? { attachments } : {}),
  }
}

function historyToolRow(toolId: string, paths: string[]): SessionLoadMessage {
  return {
    role: 'tool',
    content: '',
    toolName: 'Read',
    toolId,
    timestamp: 1,
    attachments: paths.map((p) => ({ id: `img:${p}`, type: 'image', name: p.split('/').pop()!, path: p, mimeType: 'image/png' })),
  }
}

describe('mergeHistoryAttachments', () => {
  it('attaches engine-history images onto attachment-less restored tool rows (the reported bug)', () => {
    const messages: Message[] = [toolMsg('toolu_1'), toolMsg('toolu_2')]
    const history: SessionLoadMessage[] = [
      historyToolRow('toolu_1', ['/c/images/a.png']),
      historyToolRow('toolu_2', ['/c/images/b.png', '/c/images/c.png']),
    ]

    const merged = mergeHistoryAttachments(messages, history)

    expect(merged).not.toBe(messages) // new array — changes were made
    expect(merged[0].attachments?.map((a) => (a as { path: string }).path)).toEqual(['/c/images/a.png'])
    expect(merged[1].attachments?.map((a) => (a as { path: string }).path)).toEqual(['/c/images/b.png', '/c/images/c.png'])
  })

  it('is idempotent: a row that already carries the attachment is not duplicated', () => {
    const messages: Message[] = [
      toolMsg('toolu_1', [{ id: 'img:/c/images/a.png', type: 'image', name: 'a.png', path: '/c/images/a.png', mimeType: 'image/png' }]),
    ]
    const history: SessionLoadMessage[] = [historyToolRow('toolu_1', ['/c/images/a.png'])]

    const merged = mergeHistoryAttachments(messages, history)

    // No change → same array reference (caller skips setState).
    expect(merged).toBe(messages)
    expect(merged[0].attachments).toHaveLength(1)
  })

  it('adds only the missing attachment when a row is partially populated', () => {
    const messages: Message[] = [
      toolMsg('toolu_1', [{ id: 'img:/c/images/a.png', type: 'image', name: 'a.png', path: '/c/images/a.png', mimeType: 'image/png' }]),
    ]
    const history: SessionLoadMessage[] = [historyToolRow('toolu_1', ['/c/images/a.png', '/c/images/b.png'])]

    const merged = mergeHistoryAttachments(messages, history)

    expect(merged).not.toBe(messages)
    expect(merged[0].attachments?.map((a) => (a as { path: string }).path)).toEqual(['/c/images/a.png', '/c/images/b.png'])
  })

  it('ignores history rows with no matching restored toolId', () => {
    const messages: Message[] = [toolMsg('toolu_1')]
    const history: SessionLoadMessage[] = [historyToolRow('toolu_absent', ['/c/images/x.png'])]

    const merged = mergeHistoryAttachments(messages, history)

    expect(merged).toBe(messages)
    expect(merged[0].attachments).toBeUndefined()
  })

  it('ignores history rows with no attachments', () => {
    const messages: Message[] = [toolMsg('toolu_1')]
    const history: SessionLoadMessage[] = [{ role: 'tool', content: 'ok', toolName: 'Read', toolId: 'toolu_1', timestamp: 1 }]

    const merged = mergeHistoryAttachments(messages, history)

    expect(merged).toBe(messages)
  })
})
