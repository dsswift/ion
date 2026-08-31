import { useEffect, useState } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { bootstrapResources } from '../hooks/useResourceBootstrap'
import { reportStartup } from '../startup-report'
import { waitForTabsSync, waitForWorktreeSync } from './state/secondary-store'
import { useSurfaceStore } from './surface/surface-store'
import { rError } from '../rendererLogger'
import { bootstrapPreferencesReady } from '../preferences-bootstrap'

export function useStudioBootstrap(layoutHydrated: boolean): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!layoutHydrated) return
    let cancelled = false
    void (async () => {
      try {
        reportStartup('studio', 'Synchronizing conversations…')
        await Promise.all([bootstrapPreferencesReady(), waitForTabsSync(), waitForWorktreeSync()])
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
