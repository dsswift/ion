/**
 * Window-local presence cache — mirrors the server's FR-02 `studio:presence`
 * channel (`server/src/protocol/presence.ts`), the same way `questions-store`
 * mirrors QuestionsCoordinator.
 *
 * Deliberately OUTSIDE useSessionStore: this store carries no business
 * logic and just replaces itself wholesale from the authoritative snapshot
 * on `studio_welcome`/`studio_snapshot` (first paint) and the `studio:presence`
 * broadcast (every change). Both the Electron Studio window and a browser
 * client receive the same `studio_event` frames, so one sync path serves
 * both — no `windowMirrorSync`/wire fork like `initTabsSyncFromWire` needs.
 */
import { create } from 'zustand'
import type { PresenceEntry, PresenceSnapshot } from '@ion/shared/types-presence'
import { activeTabEnvironmentId } from '../studio/connection/tab-environment'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { host, action } from '../host/host-instance'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rWarn } from '../rendererLogger'

interface PresenceCacheState {
  /** Union of every Environment's entries (ADR-033); `driving` is keyed by tab id, which is unique across Environments. */
  entries: PresenceEntry[]
  driving: Record<string, string>
  /** This connection's own subject, captured off the LOCAL `studio_welcome.principal` -- presence lists every connection including this one. */
  ownSubject: string | null
  /** Replace ONE Environment's slice and republish the union. */
  replace: (snapshot: PresenceSnapshot, environmentId?: string) => void
  setOwnSubject: (subject: string) => void
}

const byEnvironment = new Map<string, PresenceSnapshot>()

export const usePresenceStore = create<PresenceCacheState>((set) => ({
  entries: [],
  driving: {},
  ownSubject: null,
  replace: (snapshot, environmentId = LOCAL_ENVIRONMENT_ID) => {
    byEnvironment.set(environmentId, snapshot)
    const entries: PresenceEntry[] = []
    const driving: Record<string, string> = {}
    for (const snap of byEnvironment.values()) {
      entries.push(...snap.entries)
      Object.assign(driving, snap.driving)
    }
    set({ entries, driving })
  },
  setOwnSubject: (subject) => set({ ownSubject: subject }),
}))

let wired = false

/** Hydrate from the handshake/snapshot and subscribe to the broadcast. Idempotent for the window's lifetime. */
export function initPresenceSync(): () => void {
  if (wired) return () => {}
  wired = true
  return host.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome') {
      if (environmentId === LOCAL_ENVIRONMENT_ID) usePresenceStore.getState().setOwnSubject(frame.principal.subject)
      usePresenceStore.getState().replace(frame.snapshot.presence, environmentId)
    } else if (frame.type === 'studio_snapshot') {
      usePresenceStore.getState().replace(frame.snapshot.presence, environmentId)
    } else if (frame.type === 'studio_event' && frame.channel === 'studio:presence') {
      usePresenceStore.getState().replace(frame.payload as PresenceSnapshot, environmentId)
    }
  })
}

let focusReporterWired = false
let lastReportedTabId: string | null | undefined

/**
 * Reports this connection's active tab to the server (`presence.focus`)
 * whenever it changes, so other connections' presence lists reflect it.
 * Fire-and-forget: a failed report just means this connection's focus is
 * stale in others' lists until the next change, not a functional break.
 */
export function initPresenceFocusReporter(): () => void {
  if (focusReporterWired) return () => {}
  focusReporterWired = true
  const report = (tabId: string | null): void => {
    if (tabId === lastReportedTabId) return
    lastReportedTabId = tabId
    // Reported to the server that owns the focused tab; the servers that do
    // not own it see this connection as focused on nothing there.
    void action(activeTabEnvironmentId(), 'presence.focus', [tabId]).catch((err: unknown) => {
      rWarn('presence', 'focus report failed', { error: String(err) })
    })
  }
  report(useSessionStore.getState().activeTabId ?? null)
  return useSessionStore.subscribe((state) => report(state.activeTabId ?? null))
}

/** Every OTHER connection currently focused on `tabId` (excludes this connection's own entry). */
export function othersFocusedOn(entries: PresenceEntry[], ownSubject: string | null, tabId: string): PresenceEntry[] {
  return entries.filter((e) => e.focusedTabId === tabId && e.subject !== ownSubject)
}

/** The subject driving `tabId`'s in-flight run, if any and if it isn't this connection's own subject. */
export function drivingSubjectFor(driving: Record<string, string>, ownSubject: string | null, tabId: string): string | null {
  const subject = driving[tabId]
  if (!subject || subject === ownSubject) return null
  return subject
}
