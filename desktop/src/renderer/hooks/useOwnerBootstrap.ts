import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { bootstrapResources } from './useResourceBootstrap'
import { bootstrapPreferencesReady } from '../preferences-bootstrap'
import { setupModelSyncReady } from '../stores/model-store'
import { rError, rInfo } from '../rendererLogger'
import { reportStartup } from '../startup-report'

export function useOwnerBootstrap(): void {
  useEffect(() => {
    let cancelled = false
    // Sequences are per SOURCE, not per sender, and the coordinator drops any
    // report whose sequence is not ahead of the last one accepted for that
    // source. This hook and useTabRestoration both report as `owner`, so they
    // must share one counter — `startup-report.ts` owns it. A private counter
    // here shipped once and wedged startup: tab restoration had already
    // advanced `owner` to 78, this hook's own counter reached 4, and the
    // `ready` report that reveals the window and destroys the splash was
    // discarded as stale.
    const report = (status: string, ready = false, error?: string): void =>
      reportStartup('owner', status, ready, error)
    report('Loading desktop settings…')
    void (async () => {
      try {
        await bootstrapPreferencesReady()
        report('Loading resources…')
        await bootstrapResources()
        report('Loading models…')
        await setupModelSyncReady()
        await new Promise<void>((resolve, reject) => {
          const unsubscribe = useSessionStore.subscribe((next) => {
            if (next.startupError) {
              unsubscribe()
              reject(new Error(next.startupError))
            }
            if (next.tabsReady) {
              unsubscribe()
              resolve()
            }
          })
          const current = useSessionStore.getState()
          if (current.startupError) {
            unsubscribe()
            reject(new Error(current.startupError))
          } else if (current.tabsReady) {
            unsubscribe()
            resolve()
          }
        })
        if (cancelled) return
        useSessionStore.setState({ startupReady: true })
        report('Ion is ready', true)
        rInfo('startup', 'owner bootstrap complete')
      } catch (err) {
        if (cancelled) return
        const error = String(err)
        useSessionStore.setState({ startupError: error })
        report('Ion could not start', false, error)
        rError('startup', 'owner bootstrap failed', { error })
      }
    })()
    return () => { cancelled = true }
  }, [])
}
