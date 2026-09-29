/**
 * Tracks whether any consumer is currently paying attention to the app:
 * either a focused local BrowserWindow, or a connected remote client (iOS).
 *
 * Used to gate background git work: watchers can drop events while nothing is
 * watching (the renderer isn't rendering UI from them anyway). When attention
 * returns, consumers should re-fetch a snapshot.
 *
 * The remote input exists because iOS relies on proactive
 * desktop_git_changes_response pushes from the watcher bridge: with the
 * original window-focus-only gate, backgrounding the desktop silently starved
 * every connected phone of git updates (watcher logged "flush suspended,
 * dropping" while the phone's git pane sat stale). A connected paired device
 * IS an attentive consumer. The battery/CPU intent of suspension is preserved
 * for the truly-idle case: no focused window AND no connected device.
 */

import { EventEmitter } from 'events'

class FocusState extends EventEmitter {
  private _windowFocused = true
  private _remoteClients = 0

  /** Effective attention: a focused window OR at least one remote client. */
  get focused(): boolean { return this._windowFocused || this._remoteClients > 0 }

  /** The raw local-window focus, unmixed with remote attention. */
  get windowFocused(): boolean { return this._windowFocused }

  setFocused(focused: boolean): void {
    const before = this.focused
    this._windowFocused = focused
    if (this.focused !== before) this.emit('change', this.focused)
  }

  /** Report the number of connected remote clients (paired iOS devices). */
  setRemoteClientCount(count: number): void {
    const before = this.focused
    this._remoteClients = count
    if (this.focused !== before) this.emit('change', this.focused)
  }
}

export const focusState = new FocusState()
