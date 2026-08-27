import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { consumeAltHeld, watchGuestModifiers, _modifierTtlMs } from './guest-modifiers'

/**
 * A guest whose input-event listener can be fired by hand.
 *
 * Electron reports modifiers only on this stream — the window-open handler
 * that consumes them never sees a key — so the seam under test is exactly
 * this pairing.
 */
function fakeGuest(): { guest: WebContents; click: (modifiers: string[], type?: string) => void } {
  let listener: ((event: unknown, input: { type: string; modifiers?: string[] }) => void) | null = null
  const guest = {
    on: (event: string, fn: typeof listener) => {
      if (event === 'input-event') listener = fn
    },
  } as unknown as WebContents
  return {
    guest,
    click: (modifiers, type = 'mouseUp') => listener?.({}, { type, modifiers }),
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('guest modifier capture', () => {
  it('reports alt when it was held for the click', () => {
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['alt', 'meta'])
    expect(consumeAltHeld(guest)).toBe(true)
  })

  it('reports no alt for a plain cmd-click', () => {
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['meta'])
    expect(consumeAltHeld(guest)).toBe(false)
  })

  it('reports no alt when nothing was ever captured', () => {
    const { guest } = fakeGuest()
    watchGuestModifiers(guest)
    // An unwatched or never-clicked guest must not claim a modifier: a false
    // positive would fling a page into the operator's browser unbidden.
    expect(consumeAltHeld(guest)).toBe(false)
  })

  it('answers exactly one open request per click', () => {
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['alt', 'meta'])
    expect(consumeAltHeld(guest)).toBe(true)
    // Reading is destructive so one ⌥-click cannot colour a second navigation
    // the page performs on its own afterwards.
    expect(consumeAltHeld(guest)).toBe(false)
  })

  it('ignores a capture older than the correlation window', () => {
    vi.useFakeTimers()
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['alt', 'meta'])
    vi.advanceTimersByTime(_modifierTtlMs() + 50)
    // A real gesture correlates in microseconds. Anything this old belongs to
    // a different click, and guessing would redirect an unrelated navigation.
    expect(consumeAltHeld(guest)).toBe(false)
  })

  it('accepts a capture inside the correlation window', () => {
    vi.useFakeTimers()
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['alt'])
    vi.advanceTimersByTime(_modifierTtlMs() - 50)
    expect(consumeAltHeld(guest)).toBe(true)
  })

  it('ignores mouse movement', () => {
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(['alt'], 'mouseUp')
    click([], 'mouseMove')
    // Movement must not overwrite the click that is being asked about, and
    // recording every move would store thousands of records a second.
    expect(consumeAltHeld(guest)).toBe(true)
  })

  it('tracks each guest separately', () => {
    const a = fakeGuest()
    const b = fakeGuest()
    watchGuestModifiers(a.guest)
    watchGuestModifiers(b.guest)
    a.click(['alt'])
    b.click(['meta'])
    expect(consumeAltHeld(b.guest)).toBe(false)
    expect(consumeAltHeld(a.guest)).toBe(true)
  })

  it('treats a modifier-less event as no alt', () => {
    const { guest, click } = fakeGuest()
    watchGuestModifiers(guest)
    click(undefined as unknown as string[])
    expect(consumeAltHeld(guest)).toBe(false)
  })
})
