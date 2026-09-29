// @vitest-environment jsdom
/**
 * Draft durability: the composer's unsent text reaches the owning store while
 * it is being typed, not only when the operator happens to switch away.
 *
 * The defect these pin: the draft was written to the store ONLY on a tab
 * switch, so the conversation you were looking at when the app quit was the
 * one conversation whose text was never written down — and the store write was
 * window-local, so it never reached disk at all. Each test below fails on that
 * behaviour: no switch happens in the first three.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Pane = { activeInstanceId: string; instances: Array<{ id: string; draftInput: string }> }

// The real store REPLACES the pane map on every write (`commitInstance` builds
// a new Map) and a draft write lands on the pane. A mock that mutates one map
// in place and drops writes would hide exactly the bugs these tests exist to
// catch: the hook watches the map's identity to notice a pane arriving, and it
// reads the arriving conversation's own stored text back out on a switch.
let panes = new Map<string, Pane>()

const setDraftInput = vi.fn((tabId: string, textValue: string) => {
  const next = new Map(panes)
  next.set(tabId, { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: textValue }] })
  panes = next
})

const storeState = {
  setDraftInput,
  get conversationPanes(): Map<string, Pane> { return panes },
}

vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn() }))

import { useComposerDraft, DRAFT_COMMIT_DELAY_MS } from './useComposerDraft'

function pane(tabId: string, draftInput: string): void {
  const next = new Map(panes)
  next.set(tabId, { activeInstanceId: 'main', instances: [{ id: 'main', draftInput }] })
  panes = next
}

function clearPanes(): void {
  panes = new Map()
}

describe('useComposerDraft', () => {
  let root: Root
  let container: HTMLDivElement
  let text = ''
  let tabId: string | null = 'tab-a'
  let ready = true
  const setText = vi.fn((next: string) => { text = next })

  function Probe(): null {
    useComposerDraft(tabId, ready, text, setText)
    return null
  }
  const render = async (): Promise<void> => { await act(async () => { root.render(<Probe />) }) }
  /** Advance past the commit debounce. */
  const settle = async (): Promise<void> => {
    await act(async () => { vi.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS + 1) })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    clearPanes()
    pane('tab-a', '')
    text = ''
    tabId = 'tab-a'
    ready = true
    setDraftInput.mockClear()
    setText.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    vi.useRealTimers()
  })

  it('commits typed text to the store without any tab switch', async () => {
    await render()
    text = 'half a thought'
    await render()
    expect(setDraftInput).not.toHaveBeenCalled()
    await settle()
    expect(setDraftInput).toHaveBeenCalledWith('tab-a', 'half a thought')
  })

  it('coalesces a burst of typing into one write', async () => {
    await render()
    for (const next of ['h', 'ha', 'hal', 'half']) {
      text = next
      await render()
      await act(async () => { vi.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS / 4) })
    }
    await settle()
    expect(setDraftInput).toHaveBeenCalledTimes(1)
    expect(setDraftInput).toHaveBeenCalledWith('tab-a', 'half')
  })

  it('flushes the unwritten tail when the window tears down', async () => {
    await render()
    text = 'not yet debounced'
    await render()
    expect(setDraftInput).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    expect(setDraftInput).toHaveBeenCalledWith('tab-a', 'not yet debounced')
  })

  it('flushes the departing conversation and adopts the arriving one', async () => {
    await render()
    text = 'for a'
    await render()
    pane('tab-b', 'stored draft for b')
    tabId = 'tab-b'
    await render()
    expect(setDraftInput).toHaveBeenCalledWith('tab-a', 'for a')
    expect(text).toBe('stored draft for b')
  })

  it('adopts the restored draft once tabs finish loading, with no switch', async () => {
    // Boot: the conversation is already active but its panes are not loaded,
    // so there is nothing to adopt yet.
    ready = false
    pane('tab-a', '')
    await render()
    expect(setText).not.toHaveBeenCalled()
    // Restoration lands, carrying the draft read back from the tabs file.
    ready = true
    pane('tab-a', 'survived the restart')
    await render()
    expect(text).toBe('survived the restart')
  })

  it('clears the composer on a switch even when the arriving pane has not synced', async () => {
    // THE leak: the operator types in A, switches to B before B's pane has
    // reached this window, and A's half-written prompt stays on screen under
    // B's name — then B's commit timer writes those words into B, and erasing
    // them in B wipes A as well. It read as one global draft instead of one
    // per conversation. An unsynced pane must clear the composer, never keep
    // the previous conversation's text.
    pane('tab-a', '')
    await render()
    text = 'meant for A'
    await render()

    tabId = 'tab-b' // no pane for tab-b yet
    await render()

    expect(text).toBe('')
    // And nothing of A's was written under B's id.
    for (const [calledTab, calledText] of setDraftInput.mock.calls) {
      if (calledTab === 'tab-b') expect(calledText).not.toBe('meant for A')
    }
  })

  it('takes the real draft once a late pane arrives, without clobbering typing', async () => {
    pane('tab-a', '')
    await render()
    tabId = 'tab-b'
    await render()
    expect(text).toBe('')

    // B's pane lands a beat later carrying its stored draft.
    pane('tab-b', 'B had a draft')
    await render()
    expect(text).toBe('B had a draft')
  })

  it('a late pane never overwrites what the operator has already typed', async () => {
    pane('tab-a', '')
    await render()
    tabId = 'tab-b'
    await render()
    // They start typing in B before B's pane arrives.
    text = 'typing in B'
    await render()

    pane('tab-b', 'stale stored draft')
    await render()

    expect(text).toBe('typing in B')
  })

  it('waits for the conversation pane instead of adopting an empty draft', async () => {
    // Boot order the operator actually hits: restoration reports ready, the
    // conversation is already active, and its pane arrives a beat later on the
    // owner's tabs sync. Adopting on `tabsReady` alone would take '' here and,
    // because adoption happens once per open, never look again — which is how a
    // draft that survived on disk still came back blank.
    clearPanes()
    await render()
    // Nothing to adopt yet, so the composer is left empty rather than marked
    // as already-adopted — that marking is what would lose the draft.
    expect(text).toBe('')

    pane('tab-a', 'survived the restart')
    await render()

    expect(text).toBe('survived the restart')
  })

  it('never carries one conversation\'s text into another', async () => {
    // The symptom this guards: text typed in A appeared in B on switch, B's
    // debounce then wrote it to B, and erasing it in B wiped A too — one
    // shared draft instead of one per conversation. Both conversations hold
    // distinct stored drafts here, so an adoption that resolves against the
    // wrong conversation is visible in the assertion rather than hidden by a
    // coincidentally-empty pane.
    pane('tab-a', 'belongs to A')
    pane('tab-b', 'belongs to B')
    await render()
    expect(text).toBe('belongs to A')

    text = 'A, edited'
    await render()
    tabId = 'tab-b'
    await render()

    expect(text).toBe('belongs to B')
    // A's edit was flushed to A, and nothing was written under B's id.
    expect(setDraftInput).toHaveBeenCalledWith('tab-a', 'A, edited')
    for (const [calledTab, calledText] of setDraftInput.mock.calls) {
      if (calledTab === 'tab-b') expect(calledText).toBe('belongs to B')
    }

    // Back to A: its own text is still there, not B's.
    tabId = 'tab-a'
    await render()
    expect(text).toBe('A, edited')
  })

  it('does not re-send a draft it just adopted', async () => {
    pane('tab-a', 'from disk')
    await render()
    text = 'from disk'
    await render()
    await settle()
    expect(setDraftInput).not.toHaveBeenCalled()
  })
})
