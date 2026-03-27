import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

const HEALTH_POLL_INTERVAL_MS = 1500

/**
 * Health reconciliation loop: periodically compares running tabs
 * against backend health and unsticks UI when external CLI/session
 * changes happen.
 *
 * Copied from reference architecture (CopilotPill.tsx lines 1242-1271).
 */
export function useHealthReconciliation() {
  useEffect(() => {
    const timer = setInterval(async () => {
      const { tabs } = useSessionStore.getState()
      const runningTabs = tabs.filter(
        (t) => t.status === 'running' || t.status === 'connecting'
      )
      if (runningTabs.length === 0) return

      try {
        const health = await window.coda.tabHealth()
        if (!health?.tabs || !Array.isArray(health.tabs)) return

        const stateByTab = new Map(
          health.tabs.map((h) => [h.tabId, h])
        )

        // Build updated tabs, tracking whether anything actually changed
        const { tabs: currentTabs } = useSessionStore.getState()
        let changed = false
        const newTabs = currentTabs.map((t) => {
          if (t.status !== 'running' && t.status !== 'connecting') return t

          const healthEntry = stateByTab.get(t.id)
          if (!healthEntry) return t

          // Backend says dead but UI thinks it's running → unstick
          if (healthEntry.status === 'dead') {
            changed = true
            return { ...t, status: 'dead' as const, currentActivity: 'Session ended', activeRequestId: null, permissionQueue: [], permissionDenied: null }
          }

          // Backend says idle but UI thinks it's running → unstick
          // Preserve permissionDenied: if a plan-ready card was set by task_complete, keep it
          if (healthEntry.status === 'idle' && !healthEntry.alive) {
            changed = true
            return { ...t, status: 'completed' as const, currentActivity: '', activeRequestId: null, permissionQueue: [] }
          }

          // Backend says failed → unstick
          if (healthEntry.status === 'failed') {
            changed = true
            return { ...t, status: 'failed' as const, currentActivity: '', activeRequestId: null, permissionQueue: [], permissionDenied: null }
          }

          // Backend says completed → unstick
          // Preserve permissionDenied: task_complete already set the correct value
          if (healthEntry.status === 'completed') {
            changed = true
            return { ...t, status: 'completed' as const, currentActivity: '', activeRequestId: null, permissionQueue: [] }
          }

          // Backend says running but process is dead → unstick (exit handler missed)
          if (healthEntry.status === 'running' && !healthEntry.alive) {
            changed = true
            return { ...t, status: 'dead' as const, currentActivity: 'Session ended', activeRequestId: null, permissionQueue: [], permissionDenied: null }
          }

          return t
        })

        // Only write state when something actually changed
        if (changed) {
          useSessionStore.setState({ tabs: newTabs })
        }
      } catch {
        // Ignore transient health check errors
      }
    }, HEALTH_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [])
}
