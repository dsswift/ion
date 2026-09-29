/**
 * Store writes for the per-conversation settings a paired device can change
 * on a tab it names: permission mode and thinking effort.
 *
 * The store's own `setPermissionMode` / `setThinkingEffort` act on the
 * ACTIVE tab, which is a per-window notion. A device command names its tab
 * explicitly, so these write the named tab's active conversation instance
 * instead.
 */

import type { ThinkingEffort } from '@ion/shared/types-session'
import { log as _log, warn as _warn } from '../../logger'
import { useSessionStore } from '../../store/sessionStore'

const TAG = 'remote.instance-state'

type InstancePatch = { permissionMode: 'auto' | 'plan' } | { thinkingEffort: ThinkingEffort }

/** Patch the named tab's active instance. Returns false when there is none. */
function patchActiveInstance(tabId: string, patch: InstancePatch): boolean {
  let applied = false
  useSessionStore.setState((s) => {
    const pane = s.conversationPanes.get(tabId)
    if (!pane?.activeInstanceId) return {}
    const idx = pane.instances.findIndex((i) => i.id === pane.activeInstanceId)
    if (idx === -1) return {}
    const instances = pane.instances.slice()
    instances[idx] = { ...instances[idx], ...patch }
    const conversationPanes = new Map(s.conversationPanes)
    conversationPanes.set(tabId, { ...pane, instances })
    applied = true
    return { conversationPanes }
  })
  return applied
}

/**
 * Record a device-set permission mode on the tab's active instance, then
 *
 */
export function applyRemotePermissionMode(tabId: string, mode: 'auto' | 'plan'): boolean {
  const applied = patchActiveInstance(tabId, { permissionMode: mode })
  if (!applied) {
    _warn(TAG, 'permission mode not recorded: tab has no active instance', { tab_id: tabId, mode })
    return false
  }
  _log(TAG, 'permission mode recorded', { tab_id: tabId, mode })

  return true
}

/** Record a device-set thinking effort on the tab's active instance. */
export function applyRemoteThinkingEffort(tabId: string, effort: ThinkingEffort): boolean {
  const applied = patchActiveInstance(tabId, { thinkingEffort: effort })
  if (applied) _log(TAG, 'thinking effort recorded', { tab_id: tabId, effort })
  else _warn(TAG, 'thinking effort not recorded: tab has no active instance', { tab_id: tabId, effort })
  return applied
}
