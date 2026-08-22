import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { commitInstance } from '../stores/conversation-instance'
import { logTabStatusWrite, logTabStatusPatch } from '../stores/slices/tab-status-transition'
import type { TabStatus } from '../../shared/types'

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
    const timer = setInterval(() => { void reconcile() }, HEALTH_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [])
}

async function reconcile(): Promise<void> {
  const { tabs } = useSessionStore.getState()
  const runningTabs = tabs.filter(
    (t) => t.status === 'running' || t.status === 'connecting'
  )
  if (runningTabs.length === 0) return

  try {
    const health = await window.ion.tabHealth()
    if (!health?.tabs || !Array.isArray(health.tabs)) return

    const stateByTab = new Map(
      health.tabs.map((h) => [h.tabId, h])
    )

    const { tabs: currentTabs } = useSessionStore.getState()
    let changed = false
    // Per-tab instance clear to apply when we commit. 'queue+denied'
    // clears both the pending permission queue and the denial card;
    // 'queue' clears only the queue and preserves permissionDenied. We
    // collect these keyed by tabId so the single set() below can fold
    // them into a new conversationPanes via commitInstance.
    const instanceClears = new Map<string, 'queue' | 'queue+denied'>()
    const newTabs = currentTabs.map((t) => {
      if (t.status !== 'running' && t.status !== 'connecting') return t

      const healthEntry = stateByTab.get(t.id)
      if (!healthEntry) {
        // This hook is the safety net for a tab stuck showing activity, and
        // this is the branch where the net has a hole: the tab looks busy but
        // the backend health poll returned nothing for it, so there is no
        // authority to reconcile against and the tab keeps its status. A
        // conversation that stays 'connecting' with a locked composer while
        // nothing runs passes through here on every poll, silently — which is
        // why the miss is recorded rather than skipped quietly.
        logTabStatusWrite(t.id, t.status, t.status, 'health.reconcile', 'tab-missing',
          { detail: 'no health entry for an active-looking tab' })
        return t
      }

      /** Record a reconciliation before returning the patched tab. */
      const unstick = (to: TabStatus, backendStatus: string): void => {
        logTabStatusPatch(t.id, t.status as TabStatus, to, 'health.reconcile',
          { backend_status: backendStatus, backend_alive: healthEntry.alive })
      }

      // Backend says dead but UI thinks it's running → unstick
      if (healthEntry.status === 'dead') {
        changed = true
        instanceClears.set(t.id, 'queue+denied')
        unstick('dead', 'dead')
        return { ...t, status: 'dead' as const, currentActivity: 'Session ended', activeRequestId: null }
      }

      // Backend says idle but UI thinks it's running → unstick
      // Preserve permissionDenied: if a plan-ready card was set by task_complete, keep it
      if (healthEntry.status === 'idle' && !healthEntry.alive) {
        changed = true
        instanceClears.set(t.id, 'queue')
        unstick('completed', 'idle')
        return { ...t, status: 'completed' as const, currentActivity: '', activeRequestId: null }
      }

      // Backend says failed → unstick
      if (healthEntry.status === 'failed') {
        changed = true
        instanceClears.set(t.id, 'queue+denied')
        unstick('failed', 'failed')
        return { ...t, status: 'failed' as const, currentActivity: '', activeRequestId: null }
      }

      // Backend says completed → unstick
      // Preserve permissionDenied: task_complete already set the correct value
      if (healthEntry.status === 'completed') {
        changed = true
        instanceClears.set(t.id, 'queue')
        unstick('completed', 'completed')
        return { ...t, status: 'completed' as const, currentActivity: '', activeRequestId: null }
      }

      // Backend says running but process is dead → unstick (exit handler missed)
      if (healthEntry.status === 'running' && !healthEntry.alive) {
        changed = true
        instanceClears.set(t.id, 'queue+denied')
        unstick('dead', 'running')
        return { ...t, status: 'dead' as const, currentActivity: 'Session ended', activeRequestId: null }
      }

      // The backend agrees the tab is genuinely busy: no reconciliation is due.
      // Logged so a stuck tab's polls read as "backend still calls this alive"
      // rather than as an absent decision.
      logTabStatusWrite(t.id, t.status as TabStatus, t.status as TabStatus, 'health.reconcile', 'already-at-target',
        { backend_status: healthEntry.status, backend_alive: healthEntry.alive })
      return t
    })

    // Only write state when something actually changed
    if (changed) {
      useSessionStore.setState((s) => {
        // Fold every affected tab's instance clear into a new conversationPanes
        // via commitInstance. 'queue+denied' clears both the pending
        // permission queue and the denial card (dead/failed paths);
        // 'queue' clears only the queue and preserves permissionDenied so
        // a task_complete plan-ready card survives the idle/completed
        // transition (matches the prior tab-level preservation comments).
        let conversationPanes = s.conversationPanes
        for (const [tabId, kind] of instanceClears) {
          conversationPanes = commitInstance(conversationPanes, tabId, (inst) =>
            kind === 'queue+denied'
              ? { ...inst, permissionQueue: [], permissionDenied: null }
              : { ...inst, permissionQueue: [] },
          )
        }
        return { tabs: newTabs, conversationPanes }
      })
    }
  } catch {
    // Ignore transient health check errors
  }
}
