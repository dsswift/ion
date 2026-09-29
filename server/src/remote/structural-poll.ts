/**
 * Feeds the iOS snapshot cache from the server's own store, and kicks a
 * snapshot evaluation the moment a client's tab LIST changes.
 *
 * The cache (`state.rendererSnapshotCache`) used to be filled by the desktop
 * renderer pushing its projection over IPC, because the store lived there.
 * The store lives in this process now, so the same debounced, change-gated
 * projection (`store/remote-projection-push.ts`) runs here against
 * `useSessionStore` directly: one implementation, no window boundary, and no
 * client can feed the Environment a stale projection.
 *
 * The structural kick is what keeps a new tab from reaching a paired phone
 * only when the 5 s poll tick happens to come round. `pollSnapshotOnce` is
 * per-device hash-gated, so a kick that changes nothing sends nothing.
 */
import type { RemoteTabStatesPayload } from '@ion/shared/remote-projection-types'
import { error as _error, log as _log } from '../logger'
import { state } from '../state'
import { useSessionStore } from '../store/sessionStore'
import { startRemoteProjectionPush } from '../store/remote-projection-push'
import { pollSnapshotOnce } from './snapshot-polling'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('structural-poll', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('structural-poll', msg, fields)
}

/** Matches the projection push debounce so one burst of store changes is one poll. */
const STRUCTURAL_POLL_DEBOUNCE_MS = 250

/**
 * Signature of the fields whose change means a client's tab LIST is wrong,
 * as opposed to merely out of date.
 *
 * Deliberately excludes every volatile per-delta field (cost, token counts,
 * lastActivityAt, lastMessage, messageCount): those churn on
 * every streamed chunk of an active run, and they already ride the poll tick's
 * own `desktop_tab_meta` delta. Including them would kick a full snapshot
 * build on every token -- the flood `hashInputForSnapshot` prevents.
 */
export function structuralSignature(tabs: RemoteTabStatesPayload['tabs']): string {
  return tabs.map((t) => `${t.id}|${t.status}|${t.isTerminalOnly ? 1 : 0}`).join(',')
}

let lastStructuralSignature: string | null = null
let structuralPollTimer: ReturnType<typeof setTimeout> | null = null

/** Kick a snapshot evaluation when `tabs` shows a structural change; a burst collapses into one poll. */
export function scheduleStructuralSnapshotPoll(tabs: RemoteTabStatesPayload['tabs']): void {
  const signature = structuralSignature(tabs)
  if (signature === lastStructuralSignature) return
  lastStructuralSignature = signature
  if (structuralPollTimer !== null) return
  structuralPollTimer = setTimeout(() => {
    structuralPollTimer = null
    void pollSnapshotOnce().catch((err) => {
      error('structural snapshot poll failed', { error: (err as Error).message })
    })
  }, STRUCTURAL_POLL_DEBOUNCE_MS)
}

let stopFeed: (() => void) | null = null

/** Start projecting the store into the snapshot cache. Idempotent; returns the stop function. */
export function startStructuralSnapshotFeed(): () => void {
  if (stopFeed) return stopFeed
  const inner = startRemoteProjectionPush({
    getState: () => useSessionStore.getState(),
    subscribe: (listener) => useSessionStore.subscribe(listener),
    push: (payload) => {
      state.rendererSnapshotCache = { tabs: payload.tabs, resourceManifest: payload.resourceManifest, receivedAt: Date.now() }
      scheduleStructuralSnapshotPoll(payload.tabs)
    },
  })
  stopFeed = () => {
    inner()
    stopFeed = null
  }
  log('snapshot feed started')
  return stopFeed
}

export function stopStructuralSnapshotFeed(): void {
  stopFeed?.()
  _resetStructuralSnapshotGate()
}

/** TEST ONLY: clear the structural-change gate between cases. */
export function _resetStructuralSnapshotGate(): void {
  lastStructuralSignature = null
  if (structuralPollTimer !== null) {
    clearTimeout(structuralPollTimer)
    structuralPollTimer = null
  }
}
