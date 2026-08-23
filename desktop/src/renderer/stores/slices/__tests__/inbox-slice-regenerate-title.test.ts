/**
 * "Regenerate title" hydrates an unopened inbox row before reading its prompts.
 *
 * An inbox row is normally a conversation the operator has NOT opened. Its pane
 * carries the persisted message COUNT and `historyHydrated: false`, with zero
 * message rows in memory. `regenerateTabTitle` built its prompt source from
 * `instance.messages` directly, so for exactly the rows the inbox menu is used
 * on, the source was EMPTY, the no-source branch returned, and the title never
 * changed — with no user-visible failure. `settleTab` already hydrates before
 * its own emptiness decision; this is the same discipline on the same menu.
 *
 * Regression direction: removing the `needsHistoryHydration` /
 * `loadSkeletonMessages` step turns the first test red — `generateTitle` is
 * never called and `renameTab` never runs, which is precisely the reported bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { State } from '../../session-store-types'
import type { TabState } from '../../../../shared/types'

vi.mock('../../../rendererLogger', () => ({
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ engineProfiles: [] }) },
}))

import { createInboxSlice } from '../inbox-slice'

const TAB = 'inbox-row'

function userMessage(content: string) {
  return { id: `m-${content}`, role: 'user', content }
}

/**
 * A pane as an UNOPENED inbox row actually holds it: a positive persisted
 * count, `historyHydrated: false`, and no rows. `loadSkeletonMessages` is the
 * only thing that turns it into real messages.
 */
function skeletonPane() {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', label: 'main', messages: [], messageCount: 42, historyHydrated: false }],
  }
}

function hydratedPane(messages: ReturnType<typeof userMessage>[]) {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', label: 'main', messages, messageCount: messages.length, historyHydrated: true }],
  }
}

function tab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: TAB,
    title: 'Are my conversations 1787272683672-4e...',
    customTitle: null,
    workingDirectory: '/Users/dev/src/ion',
    ...overrides,
  } as unknown as TabState
}

/**
 * Drives the slice against a minimal store. `loadSkeletonMessages` swaps the
 * skeleton pane for a hydrated one, exactly as the real hydration does, so the
 * post-await re-read sees rows only if the action actually awaited it.
 */
function harness(opts: { pane?: unknown; hydrateTo?: ReturnType<typeof userMessage>[] } = {}) {
  const loadSkeletonMessages = vi.fn(async (id: string) => {
    if (!opts.hydrateTo) return
    state.conversationPanes = new Map(state.conversationPanes).set(
      id,
      hydratedPane(opts.hydrateTo) as never,
    )
  })
  const renameTab = vi.fn()
  let state = {
    tabs: [tab()],
    conversationPanes: new Map([[TAB, opts.pane ?? skeletonPane()]]),
    loadSkeletonMessages,
    renameTab,
  } as unknown as State
  const set = (updater: (current: State) => Partial<State>): void => {
    state = { ...state, ...updater(state) } as never
  }
  const get = (): State => state as never
  const slice = createInboxSlice(set as never, get as never)
  return { slice, loadSkeletonMessages, renameTab, state: () => state, drop: () => { state.tabs = [] } }
}

const generateTitle = vi.fn(async () => 'A regenerated title')

beforeEach(() => {
  generateTitle.mockClear()
  generateTitle.mockResolvedValue('A regenerated title')
  ;(globalThis as unknown as { window: unknown }).window = { ion: { generateTitle } }
})

describe('markTabRead', () => {
  it('records the visit and clears a manual unread marker', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(4_000))
    const h = harness()
    h.state().tabs[0].lastVisitedAt = 2_000
    h.state().tabs[0].manualUnread = true

    h.slice.markTabRead?.(TAB)

    expect(h.state().tabs[0]).toMatchObject({ lastVisitedAt: 4_000, manualUnread: false })
    vi.useRealTimers()
  })
})

describe('regenerateTabTitle', () => {
  it('hydrates an unopened row, then titles it from the loaded prompts', async () => {
    const { slice, loadSkeletonMessages, renameTab } = harness({
      hydrateTo: [userMessage('first ask'), userMessage('second ask')],
    })

    await slice.regenerateTabTitle?.(TAB)

    // The hydration is what the bug was missing.
    expect(loadSkeletonMessages).toHaveBeenCalledWith(TAB)
    // The prompt source is built from the HYDRATED rows, not the empty skeleton.
    expect(generateTitle).toHaveBeenCalledWith('first ask\n\nsecond ask')
    expect(renameTab).toHaveBeenCalledWith(TAB, 'A regenerated title')
  })

  it('does not re-hydrate a row whose scrollback is already loaded', async () => {
    const { slice, loadSkeletonMessages, renameTab } = harness({
      pane: hydratedPane([userMessage('already here')]),
    })

    await slice.regenerateTabTitle?.(TAB)

    expect(loadSkeletonMessages).not.toHaveBeenCalled()
    expect(generateTitle).toHaveBeenCalledWith('already here')
    expect(renameTab).toHaveBeenCalledWith(TAB, 'A regenerated title')
  })

  it('renames nothing when the conversation genuinely has no user prompts', async () => {
    const { slice, renameTab } = harness({ pane: hydratedPane([]) })

    await slice.regenerateTabTitle?.(TAB)

    expect(generateTitle).not.toHaveBeenCalled()
    expect(renameTab).not.toHaveBeenCalled()
  })

  it('renames nothing when the tab closes while the scrollback is loading', async () => {
    const harnessed = harness({ hydrateTo: [userMessage('first ask')] })
    harnessed.loadSkeletonMessages.mockImplementation(async () => { harnessed.drop() })

    await harnessed.slice.regenerateTabTitle?.(TAB)

    expect(generateTitle).not.toHaveBeenCalled()
    expect(harnessed.renameTab).not.toHaveBeenCalled()
  })

  it('keeps the existing title when the model returns nothing', async () => {
    generateTitle.mockResolvedValue('')
    const { slice, renameTab } = harness({ hydrateTo: [userMessage('first ask')] })

    await slice.regenerateTabTitle?.(TAB)

    expect(renameTab).not.toHaveBeenCalled()
  })
})
