import { useEffect, useState } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { onLocalModelsFetched, setupModelSync } from '@ion/server/store/model-store'
import type { ModelEntry } from '@ion/shared/types-models'
import { bootstrapResources } from '../hooks/useResourceBootstrap'
import { reportStartup } from '../startup-report'
import { useSurfaceStore } from './surface/surface-store'
import { rError } from '../rendererLogger'
import { bootstrapPreferencesReady } from '../preferences-bootstrap'
import { usePreferencesStore } from '../preferences'
import { registry } from './connection/registry'
import { environmentAvailability } from './connection/environment-availability'

/** Runs once per window lifetime (spec 16 row 5): initial fetch, periodic refresh, and the `ion:models-updated` listener. */
let modelSyncStarted = false

/**
 * A fresh local catalog can retire a saved model id. This window's preference
 * store rewrites it and saves the change over the wire, once the saved
 * preferences have loaded so it never rewrites the defaults instead.
 */
function normalizeLocalModelPreferences(models: ModelEntry[]): void {
  void bootstrapPreferencesReady()
    .then(() => usePreferencesStore.getState().normalizeModelPreferences(models))
    .catch((err: unknown) => rError('studio-bootstrap', 'normalize model preferences failed', { error: String(err) }))
}

/**
 * Boots the environment registry and the availability store exactly once per
 * window
 * lifetime, independent of `layoutHydrated` -- a real, previously-broken
 * dependency the comment below used to just assert rather than enforce.
 *
 * A browser Studio client's `useStudioLayout` hydration reads persisted
 * layout through `host.shell.studioGetSettings()`, a bridged call that can
 * only resolve once `registry.boot()` has opened the studio-wire
 * connection. When that boot lived inside the effect below, gated on
 * `layoutHydrated`, this created an exact circular wait: layout hydration
 * blocked on a network call that could not complete until the registry
 * booted, and the registry never booted until layout hydration finished.
 * Every fresh page load paid the bridged call's full 30s timeout before
 * `useStudioLayout`'s `.catch()` finally set `hydrated`, unblocking the
 * registry boot that should have run from the first render -- observed
 * live 2026-09-16 as "the page hangs for ~30 seconds, then everything
 * shows up at once," alongside two other unrelated bridged calls
 * (`settings.load`, `presence.focus`) timing out for the identical reason.
 */
let connectionBootStarted = false
function useConnectionBoot(): void {
  useEffect(() => {
    if (connectionBootStarted) return
    connectionBootStarted = true
    // Before the registry, so no phase transition is missed: the
    // availability store is what drops an Environment's rows once its wire
    // has been down past the grace window.
    environmentAvailability.boot()
    registry.boot()
  }, [])
}

export function useStudioBootstrap(layoutHydrated: boolean): boolean {
  const [ready, setReady] = useState(false)
  useConnectionBoot()
  useEffect(() => {
    if (!layoutHydrated) return
    let cancelled = false
    if (!modelSyncStarted) {
      modelSyncStarted = true
      onLocalModelsFetched(normalizeLocalModelPreferences)
      setupModelSync()
    }
    void (async () => {
      try {
        reportStartup('studio', 'Synchronizing conversations…')
        // Tabs, terminals and worktrees hydrate from the wire as frames arrive
        // (boot-mirror.ts); nothing here waits on them.
        await bootstrapPreferencesReady()
        reportStartup('studio', 'Loading workspace state…')
        await bootstrapResources()
        const activeTabId = useSessionStore.getState().activeTabId
        if (activeTabId) {
          await useSessionStore.getState().loadSkeletonMessages(activeTabId)
        }
        reportStartup('studio', 'Restoring Studio workspace…')
        await useSurfaceStore.getState().hydrate()
        if (cancelled) return
        setReady(true)
        reportStartup('studio', 'Ion Studio is ready', true)
      } catch (err) {
        if (cancelled) return
        const message = String(err)
        reportStartup('studio', 'Ion Studio could not start', false, message)
        rError('startup', 'studio bootstrap failed', { error: message })
      }
    })()
    return () => { cancelled = true }
  }, [layoutHydrated])
  return ready
}
