/**
 * Surface persistence: the debounced write and its flush.
 *
 * Extracted from `surface-store.ts` to keep that file under the size cap, and
 * because these two functions are one mechanism: a write that is deliberately
 * delayed, plus the escape hatch for when the window will not survive the
 * delay.
 *
 * The debounce exists because tab churn is bursty — opening a file moves the
 * active tab, reorders, and persists, several times in a few hundred
 * milliseconds. Writing on each step would hammer the settings file for state
 * that is about to change again.
 *
 * The flush exists because a quit can outrun that delay. Without it, a tab
 * opened moments before closing Ion was simply gone on restart, while older
 * tabs survived — the write had never happened.
 */
import { useEffect } from 'react'
import type { NotificationTab, PinnableSingletonId, ScratchProject, SurfaceConversationPersisted } from '../../../shared/studio-surface-types'
import { serializeSurface } from '../../../shared/studio-surface-persistence'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

const PERSIST_DEBOUNCE_MS = 300

/** The state the writer needs; a subset of the surface store. */
export interface PersistableSurface {
  pinnedTabs: PinnableSingletonId[]
  notification: NotificationTab | null
  scratchProjects: Record<string, ScratchProject>
  conversations: Record<string, SurfaceConversationPersisted>
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let readState: (() => PersistableSurface) | null = null

/** Point the writer at the live store. Called once when the store is created. */
export function configureSurfacePersist(read: () => PersistableSurface): void {
  readState = read
}

function write(state: PersistableSurface, reason: string, onResult?: (ok: boolean) => void): void {
  const payload = serializeSurface(state.pinnedTabs, state.notification, state.conversations, state.scratchProjects)
  // Logged per write with the shape that matters when a tab comes back
  // missing: which conversation keys carry content, and whether the panel was
  // recorded open. Without this a lost tab is indistinguishable from a tab
  // that was never written.
  const withContent = Object.entries(payload.conversations)
    .filter(([, conv]) => conv.tabs.length > 0 || conv.visible)
    .map(([id, conv]) => `${id.slice(0, 8)}:${conv.tabs.length}${conv.visible ? '+open' : ''}`)
  rInfo('studio.surface', 'persisting surface state', {
    reason,
    conversation_count: Object.keys(payload.conversations).length,
    with_content: withContent.length,
    detail: withContent.slice(0, 12).join(' '),
  })
  void window.ion.studioSetSetting('studioSurface', payload)
    .then((ok) => onResult?.(ok))
    .catch((err) => rWarn('studio.surface', 'surface persist failed', { reason, error: String(err) }))
}

/** Queue a write, replacing any write already queued. */
export function scheduleSurfacePersist(read: () => PersistableSurface): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const state = read()
    write(state, 'debounce', (ok) => {
      if (!ok) rWarn('studio.surface', 'surface persist rejected by validator', { conversation_count: Object.keys(state.conversations).length })
      else rDebug('studio.surface', 'surface state persisted', { conversation_count: Object.keys(state.conversations).length, pinned_count: state.pinnedTabs.length })
    })
  }, PERSIST_DEBOUNCE_MS)
}

/**
 * Write any queued state immediately.
 *
 * A no-op when nothing is queued, so closing an idle window does not write for
 * the sake of writing.
 */
export function flushSurfacePersist(): void {
  if (!persistTimer || !readState) return
  clearTimeout(persistTimer)
  persistTimer = null
  write(readState(), 'flush-on-unload')
}

/**
 * Flush surface state when the window goes away.
 *
 * `pagehide` rather than `beforeunload`: it is the last event a renderer is
 * guaranteed to receive, including on the paths where the window is closed for
 * it rather than by it.
 */
export function useSurfacePersistOnUnload(): void {
  useEffect(() => {
    const flush = (): void => flushSurfacePersist()
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])
}
