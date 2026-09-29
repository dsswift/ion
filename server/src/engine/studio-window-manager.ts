/**
 * Studio window notification seam.
 *
 * A Studio client is not always an Electron `BrowserWindow`. Server-side
 * engine wiring (`event-wiring.ts`, `event-wiring-resources.ts`,
 * `user-turn-echo.ts`) pushes updates to whichever client is attached, and
 * this is the seam that decides how: the desktop registers its real,
 * Electron-bound implementations at startup, and a standalone server falls
 * back to `broadcastStudioNotifier` below.
 *
 * The fallback is NOT an optimisation. Before it existed, a headless server
 * dropped every push with a log line: a browser client's permission bubble
 * never cleared when the question was answered elsewhere, and a user turn
 * submitted from another surface never appeared in its transcript. "There is
 * no Studio window to push to" was true of Electron windows and false of
 * clients.
 */
import type { StudioUserMessageEcho, StudioHistoryReplace } from '@ion/shared/types-studio'
import { IPC } from '@ion/shared/types'
import { broadcast } from '../broadcast'
export interface StudioWindowNotifier {
  notifyStudioActiveTab(tabId: string): void
  notifyStudioPermissionResolved(tabId: string, questionId: string): void
  notifyStudioUserMessageEcho(tabId: string, echo: StudioUserMessageEcho): void
  /**
   * A rewind committed a new message list for one instance. The mirror
   * REPLACES the pane instance's messages wholesale, never merges, matching
   * `desktop_conversation_history`'s replace semantics on the iOS wire.
   */
  notifyStudioHistoryReplace(payload: StudioHistoryReplace): void
}

/**
 * The wire fallback: every push becomes a `studio_event` frame on its own
 * registered channel, which reaches every attached Studio connection.
 */
const broadcastStudioNotifier: StudioWindowNotifier = {
  notifyStudioActiveTab(tabId) {
    broadcast(IPC.STUDIO_ACTIVE_TAB, tabId)
  },
  notifyStudioPermissionResolved(tabId, questionId) {
    // Positional, matching the preload's `(tabId, questionId)` callback:
    // the wire subscription spreads the args, so both hosts deliver the
    // identical shape to the same `initPermissionResolutionSync` bridge.
    broadcast(IPC.STUDIO_PERMISSION_RESOLVED, tabId, questionId)
  },
  notifyStudioUserMessageEcho(tabId, echo) {
    broadcast(IPC.STUDIO_USER_MESSAGE_ECHO, tabId, echo)
  },
  notifyStudioHistoryReplace(payload) {
    broadcast(IPC.STUDIO_HISTORY_REPLACE, payload)
  },
}

let notifier: StudioWindowNotifier = broadcastStudioNotifier

/** Registers the real (Electron-bound) Studio window implementations. Desktop-only. */
export function setStudioWindowNotifier(impl: StudioWindowNotifier): void {
  notifier = impl
}

export function notifyStudioActiveTab(tabId: string): void {
  notifier.notifyStudioActiveTab(tabId)
}

export function notifyStudioPermissionResolved(tabId: string, questionId: string): void {
  notifier.notifyStudioPermissionResolved(tabId, questionId)
}

export function notifyStudioUserMessageEcho(tabId: string, echo: StudioUserMessageEcho): void {
  notifier.notifyStudioUserMessageEcho(tabId, echo)
}

export function notifyStudioHistoryReplace(payload: StudioHistoryReplace): void {
  notifier.notifyStudioHistoryReplace(payload)
}
