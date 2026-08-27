/**
 * open-link — one decision for every web link the operator clicks in Ion.
 *
 * Three surfaces show links (the conversation transcript, a terminal pane, and
 * a page inside a Surface browser tab) and they used to each call
 * `openExternal` directly. Routing them through one helper is what keeps
 * "⌘-click opens it in the Surface browser" from being three subtly different
 * behaviours that drift apart.
 *
 * The rules, in order:
 *
 *   1. **⌘ (or Ctrl on a non-Mac keyboard) is required.** A plain click keeps
 *      going to the operating system's default browser. Making the embedded
 *      browser the default for every click would quietly change where all of
 *      the operator's links land, which is not a decision a link click should
 *      make for them.
 *   2. **⌥ escapes back out.** ⌘⌥-click sends the link to the default browser
 *      even from inside Studio. Some links belong in a real browser — a
 *      password manager, a signed-in profile, an extension — and needing one is
 *      not a reason to go hunting for a menu.
 *   3. **Only http(s) routes inward.** A `mailto:`, `vscode://`, or custom
 *      scheme has no meaning in a Chromium tab and belongs to the OS handler.
 *   4. **Only Studio has somewhere to put it.** The Overlay never registers a
 *      content router, so it falls through to the OS with no branch on window
 *      role — same seam the file-open routing already uses.
 *
 * Every path ends in a link being opened somewhere. There is no case where a
 * click is silently dropped.
 */
import { surfaceRouter } from './file-open-router'
import { rDebug, rWarn } from '../rendererLogger'

/** The modifier fields this helper needs, present on React and DOM events. */
export interface LinkModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

/**
 * True when the operator asked for the embedded browser.
 *
 * `metaKey` is ⌘ on macOS; `ctrlKey` covers an external PC keyboard and the
 * Linux/Windows builds. Accepting both means the gesture works without asking
 * the operator which platform convention Ion follows.
 *
 * ⌥ deliberately cancels it: that combination is the escape to the real
 * browser, so it must not also satisfy the inward route.
 */
export function wantsSurfaceBrowser(event: LinkModifiers | null | undefined): boolean {
  if (!event || event.altKey === true) return false
  return event.metaKey === true || event.ctrlKey === true
}

/** True when the operator asked for their own browser instead. */
export function wantsNativeBrowser(event: LinkModifiers | null | undefined): boolean {
  return event?.altKey === true && (event.metaKey === true || event.ctrlKey === true)
}

/** True for a URL the embedded Chromium tab can actually display. */
export function isWebUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false // silent-ok: an unparseable href is handed to the OS below
  }
}

/**
 * Open a link the operator clicked.
 *
 * Pass the click event so the modifier can be read. Call sites that have no
 * event (a programmatic open) pass `null` and always reach the OS handler.
 */
export function openClickedLink(url: string, event?: LinkModifiers | null, context = 'link'): void {
  const target = String(url)
  if (!target) return

  if (wantsSurfaceBrowser(event) && isWebUrl(target)) {
    const router = surfaceRouter()
    // `openUrl` is optional on the router contract and returns false for a URL
    // it declines, so both an older router and a refusal fall through to the OS
    // rather than losing the click.
    if (router?.openUrl?.(target)) {
      rDebug(context, 'opened link in studio surface browser', { host: hostOf(target) })
      return
    }
  } else if (wantsNativeBrowser(event)) {
    // Logged distinctly from the plain-click fallback below: this one was an
    // explicit escape, and knowing the operator asked for it is what separates
    // "they wanted their own browser" from "routing failed".
    rDebug(context, 'opened link in the default browser by request', { host: hostOf(target) })
  }

  void window.ion.openExternal(target).catch((err) => {
    rWarn(context, 'open link failed', { host: hostOf(target), error: String(err) })
  })
}

/** Host only: a full URL in a log line can carry tokens in its query. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}
