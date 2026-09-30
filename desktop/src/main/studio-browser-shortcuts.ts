/**
 * studio-browser-shortcuts — keyboard shortcuts pressed inside a browser guest.
 *
 * The guest holds keyboard focus and is not part of the Studio document, so a
 * renderer `keydown` listener never sees a key pressed in a page. The only
 * place a browser shortcut can be observed is the guest's own
 * `before-input-event`, in main.
 *
 * Two kinds of shortcut come out of it. Ones the guest can satisfy itself
 * (reload, history, zoom) are applied here. Ones that change the chrome
 * (focus the URL bar, open or close find) are handed to the renderer through a
 * sender the IPC layer injects, because the renderer owns that DOM.
 *
 * The modifier is an explicit platform branch: the command key on macOS, the
 * control key on Windows and Linux. Reading `meta || control` would make
 * Ctrl+L on a Mac, which a page may bind, silently steal focus.
 */
import type { Input, WebContents } from 'electron'
import { log as _log } from './logger'

const TAG = 'studio-browser-shortcuts'

export type BrowserShortcutAction =
  | 'focus-url-bar'
  | 'open-find'
  | 'close-find'
  | 'find-next'
  | 'find-previous'
  | 'reload'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'

/** The subset of `Electron.Input` a shortcut decision reads. */
export type ShortcutInput = Pick<Input, 'type' | 'key' | 'control' | 'meta' | 'shift' | 'alt' | 'isAutoRepeat'>

/**
 * Which browser shortcut, if any, a key press is.
 *
 * Pure so both platforms are pinned by test without a WebContents. `null`
 * means "not ours": the key goes to the page untouched.
 */
export function resolveBrowserShortcut(input: ShortcutInput, platform: NodeJS.Platform): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  // Escape carries no modifier and is only meaningful while a find is open;
  // the installer checks that before consuming it.
  if (key === 'Escape' && !input.meta && !input.control && !input.alt) return 'close-find'

  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
  if (platform === 'win32' && input.alt && !input.control && !input.meta) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
  }
  if (!mod || input.alt) return null

  switch (key) {
    case 'l': return 'focus-url-bar'
    case 'f': return 'open-find'
    case 'g': return input.shift ? 'find-previous' : 'find-next'
    case 'r': return 'reload'
    case '[': return 'back'
    case ']': return 'forward'
    case 'ArrowLeft': return platform === 'darwin' ? 'back' : null
    case 'ArrowRight': return platform === 'darwin' ? 'forward' : null
    case '=':
    case '+': return 'zoom-in'
    case '-': return 'zoom-out'
    case '0': return 'zoom-reset'
    default: return null
  }
}

export interface BrowserShortcutDeps {
  /** Is a find-in-page session open on this guest? Gates Escape and find-next. */
  findActive(): boolean
  /** Repeat the last find in a direction. */
  findAgain(forward: boolean): void
  /** Apply a zoom step or reset; the chrome learns the level from view state. */
  zoom(request: 'in' | 'out' | 'reset'): void
  /** Hand a chrome-changing shortcut to the renderer. */
  sendToChrome(action: 'focus-url-bar' | 'open-find' | 'close-find'): void
}

/** Wire `before-input-event` on one guest. */
export function installBrowserShortcuts(guest: WebContents, context: { conversationId: string; instanceId: string }, deps: BrowserShortcutDeps): void {
  guest.on('before-input-event', (event, input) => {
    const action = resolveBrowserShortcut(input, process.platform)
    if (!action) return
    // Find-scoped keys go to the page when no find is open: Escape closes a
    // page's own dialog, and ⌘G is whatever the page bound.
    if ((action === 'close-find' || action === 'find-next' || action === 'find-previous') && !deps.findActive()) return
    if (input.isAutoRepeat && (action === 'reload' || action === 'back' || action === 'forward' || action === 'focus-url-bar')) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    _log(TAG, 'browser shortcut', { conversation_id: context.conversationId, instance_id: context.instanceId, action })
    switch (action) {
      case 'reload': guest.reload(); return
      case 'back': if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack(); return
      case 'forward': if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward(); return
      case 'zoom-in': deps.zoom('in'); return
      case 'zoom-out': deps.zoom('out'); return
      case 'zoom-reset': deps.zoom('reset'); return
      case 'find-next': deps.findAgain(true); return
      case 'find-previous': deps.findAgain(false); return
      case 'focus-url-bar':
      case 'open-find':
      case 'close-find':
        deps.sendToChrome(action)
        return
    }
  })
}
