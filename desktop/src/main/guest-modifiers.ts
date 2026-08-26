/**
 * guest-modifiers — what the operator was holding when a guest page opened a link.
 *
 * Electron's `setWindowOpenHandler` reports a `disposition`, not modifier keys.
 * That is enough to recognise a ⌘-click (Chromium turns it into a
 * `background-tab` request) but NOT enough to tell ⌘-click apart from
 * ⌥⌘-click: Blink's `NavigationPolicyFromEventModifiers` maps both to the same
 * new-tab policy, so the Option key never reaches the handler.
 *
 * So the modifier state is captured separately, from the guest's raw
 * `input-event` stream, and read back when the open request arrives.
 *
 * The correlation is by time, which deserves justification. The mouse-up that
 * triggers a navigation and the resulting window-open request happen in the
 * same user gesture, microseconds apart on the same WebContents. A stored
 * modifier older than a short window is therefore not from this click and is
 * ignored — which is what keeps a stale Option press from redirecting an
 * unrelated navigation minutes later. If the record has expired the caller
 * falls back to the disposition alone, i.e. the ⌘-click behaviour, which is
 * the safe direction: a missed ⌥ opens a Surface tab the operator can dismiss,
 * whereas a false ⌥ would fling a page into their browser unbidden.
 */
import type { WebContents } from 'electron'

/**
 * How long a captured modifier stays valid.
 *
 * Generous relative to the microseconds a real gesture takes, so a busy main
 * process cannot drop a legitimate ⌥, but far below the seconds it would take
 * a human to press Option and click something unrelated.
 */
const MODIFIER_TTL_MS = 1_000

interface Captured {
  alt: boolean
  at: number
}

const lastMouseModifiers = new WeakMap<WebContents, Captured>()

/**
 * Watch a guest's input events so its modifier state is known.
 *
 * Only mouse-down/up are recorded. Tracking every `mouseMove` would store
 * thousands of records a second to answer a question only a click can ask.
 */
export function watchGuestModifiers(guest: WebContents): void {
  guest.on('input-event', (_event, input) => {
    if (input.type !== 'mouseDown' && input.type !== 'mouseUp') return
    const modifiers = input.modifiers ?? []
    lastMouseModifiers.set(guest, { alt: modifiers.includes('alt'), at: Date.now() })
  })
}

/**
 * Was Option held for the click that is opening this link?
 *
 * Reading is destructive: one captured click answers exactly one open request,
 * so a single ⌥-click can never colour a second navigation the page makes on
 * its own afterwards.
 */
export function consumeAltHeld(guest: WebContents): boolean {
  const captured = lastMouseModifiers.get(guest)
  lastMouseModifiers.delete(guest)
  if (!captured) return false
  return captured.alt && Date.now() - captured.at <= MODIFIER_TTL_MS
}

/** Test seam: the window a captured modifier stays valid for. */
export function _modifierTtlMs(): number {
  return MODIFIER_TTL_MS
}
