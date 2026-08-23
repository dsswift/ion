import type { StoreGet, StoreSet, State } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import { rInfo, rWarn } from '../../rendererLogger'

/** Exact-ID control for one session-owned background Bash task. */
export function createBackgroundTaskSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    stopBackgroundTask: async (tabId, taskId) => {
      if (!taskId) {
        rWarn('background-task.stop', 'refused empty task id', { tab_id: tabId.slice(0, 8) })
        return { ok: false, error: 'No background task ID was provided.' }
      }
      if (!get().tabs.some((tab) => tab.id === tabId)) {
        rWarn('background-task.stop', 'refused unknown tab', { tab_id: tabId.slice(0, 8), task_id: taskId })
        return { ok: false, error: 'The conversation is no longer available.' }
      }

      rInfo('background-task.stop', 'requesting stop', { tab_id: tabId.slice(0, 8), task_id: taskId })
      try {
        const result = await window.ion.engineStopBackgroundTask(tabId, taskId)
        if (result.ok && result.status === 'stopped') {
          rInfo('background-task.stop', 'stop accepted', { tab_id: tabId.slice(0, 8), task_id: taskId })
          return result
        }
        const error = result.error || `Background task stop returned ${result.status || 'an unknown result'}.`
        rWarn('background-task.stop', 'stop refused', { tab_id: tabId.slice(0, 8), task_id: taskId, status: result.status ?? '', error })
        appendFailure(set, get, tabId, error)
        return { ...result, ok: false, error }
      } catch (err) {
        const error = String(err)
        rWarn('background-task.stop', 'IPC failed', { tab_id: tabId.slice(0, 8), task_id: taskId, error })
        appendFailure(set, get, tabId, error)
        return { ok: false, error }
      }
    },
  }
}

function appendFailure(set: StoreSet, get: StoreGet, tabId: string, detail: string): void {
  const notifications = new Map(get().engineNotifications)
  const current = [...(notifications.get(tabId) ?? [])]
  current.push({
    id: nextMsgId(),
    message: `Could not stop background task: ${detail}`,
    level: 'error',
    timestamp: Date.now(),
  })
  notifications.set(tabId, current)
  set({ engineNotifications: notifications })
}
