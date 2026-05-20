/**
 * Tracks whether any BrowserWindow is currently focused.
 *
 * Used to gate background git work: watchers can drop events while the app is
 * blurred (the renderer isn't rendering UI from them anyway). When focus
 * returns, consumers should re-fetch a snapshot.
 */

import { EventEmitter } from 'events'

class FocusState extends EventEmitter {
  private _focused = true

  get focused(): boolean { return this._focused }

  setFocused(focused: boolean): void {
    if (this._focused === focused) return
    this._focused = focused
    this.emit('change', focused)
  }
}

export const focusState = new FocusState()
