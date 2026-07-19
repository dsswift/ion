import { describe, it, expect, vi, beforeEach } from 'vitest'
import { focusState } from '../focus-state'

// The singleton carries state across tests; reset to the boot defaults.
beforeEach(() => {
  focusState.removeAllListeners()
  focusState.setRemoteClientCount(0)
  focusState.setFocused(true)
})

describe('focusState — remote clients count as attention (git watcher gate)', () => {
  it('stays focused when the window blurs while a remote client is connected', () => {
    // The defect: backgrounding the desktop suspended the git watcher, so a
    // connected iOS device got zero proactive git pushes ("flush suspended,
    // dropping" in the logs) while its git pane sat stale.
    focusState.setRemoteClientCount(1)
    focusState.setFocused(false)
    expect(focusState.focused).toBe(true)
  })

  it('unfocuses when the window blurs with no remote clients (battery intent preserved)', () => {
    focusState.setFocused(false)
    expect(focusState.focused).toBe(false)
  })

  it('emits change when the last remote client disconnects while blurred', () => {
    focusState.setRemoteClientCount(1)
    focusState.setFocused(false)
    const events: boolean[] = []
    focusState.on('change', (f: boolean) => events.push(f))

    focusState.setRemoteClientCount(0)

    expect(events).toEqual([false])
    expect(focusState.focused).toBe(false)
  })

  it('does not emit when remote count changes without flipping effective focus', () => {
    const spy = vi.fn()
    focusState.on('change', spy)
    // Window is focused; adding a client cannot change effective focus.
    focusState.setRemoteClientCount(2)
    expect(spy).not.toHaveBeenCalled()
  })

  it('windowFocused exposes the raw local focus, unmixed with remote attention', () => {
    // The intercept router needs the human-at-the-desktop signal, not the
    // watcher gate (see event-wiring-intercept.ts).
    focusState.setRemoteClientCount(1)
    focusState.setFocused(false)
    expect(focusState.windowFocused).toBe(false)
    expect(focusState.focused).toBe(true)
  })
})
