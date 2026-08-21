/**
 * Inbox command handlers (desktop↔iOS wire, lockstep — ADR-008).
 *
 * Each command routes into the OWNER renderer's forwarded store action via
 * executeJavaScript (the established command→owner-action path): the store
 * is the single writer of tab metadata, so main never mutates tabs.json
 * directly. Snapshots pick the change up on the next poll cycle.
 */
import { state } from '../../state'
import { log as _log, warn as _warn } from '../../logger'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('remote-inbox', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('remote-inbox', msg, fields)
}

const TAB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

async function callOwnerAction(action: string, tabId: string, extraArg?: string): Promise<void> {
  if (!TAB_ID_RE.test(tabId)) {
    warn('inbox command rejected: bad tabId', { action, tab_id: String(tabId).slice(0, 32) })
    return
  }
  if (!state.mainWindow) {
    warn('inbox command dropped: no owner window', { action })
    return
  }
  try {
    const applied = await state.mainWindow.webContents.executeJavaScript(`
      (async function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return false;
        return await store.getState().${action}('${tabId}'${extraArg !== undefined ? `, ${extraArg}` : ''}) !== false;
      })()
    `)
    log(applied === false ? 'inbox command refused' : 'inbox command applied', { action, tab_id: tabId.slice(0, 8) })
  } catch (err) {
    warn('inbox command failed', { action, tab_id: tabId.slice(0, 8), error: String(err) })
  }
}

export async function handleTabSettle(cmd: Extract<RemoteCommand, { type: 'desktop_tab_settle' }>): Promise<void> {
  await callOwnerAction('settleTab', cmd.tabId)
}

export async function handleTabReviewSettled(cmd: Extract<RemoteCommand, { type: 'desktop_review_settled_tab' }>): Promise<void> {
  await callOwnerAction('restoreSettledHistoryTab', cmd.tabId)
}

export async function handleTabUnsettle(cmd: Extract<RemoteCommand, { type: 'desktop_tab_unsettle' }>): Promise<void> {
  await callOwnerAction('unsettleTab', cmd.tabId, "'user'")
}

export async function handleTabSnooze(cmd: Extract<RemoteCommand, { type: 'desktop_tab_snooze' }>): Promise<void> {
  const until = Number(cmd.untilMs)
  if (!Number.isFinite(until) || until <= 0) {
    warn('snooze rejected: bad untilMs', { until_ms: String(cmd.untilMs) })
    return
  }
  await callOwnerAction('snoozeTab', cmd.tabId, String(Math.round(until)))
}

export async function handleTabUnsnooze(cmd: Extract<RemoteCommand, { type: 'desktop_tab_unsnooze' }>): Promise<void> {
  await callOwnerAction('unsnoozeTab', cmd.tabId)
}

export async function handleTabMarkUnread(cmd: Extract<RemoteCommand, { type: 'desktop_tab_mark_unread' }>): Promise<void> {
  await callOwnerAction('markTabUnread', cmd.tabId)
}

export async function handleTabPin(cmd: Extract<RemoteCommand, { type: 'desktop_tab_pin' }>): Promise<void> {
  await callOwnerAction('pinTab', cmd.tabId)
}

export async function handleTabUnpin(cmd: Extract<RemoteCommand, { type: 'desktop_tab_unpin' }>): Promise<void> {
  await callOwnerAction('unpinTab', cmd.tabId)
}

export async function handleTabRegenerateTitle(cmd: Extract<RemoteCommand, { type: 'desktop_tab_regenerate_title' }>): Promise<void> {
  await callOwnerAction('regenerateTabTitle', cmd.tabId)
}

export async function handleTabReorderPin(cmd: Extract<RemoteCommand, { type: 'desktop_tab_reorder_pin' }>): Promise<void> {
  const assignments = cmd.assignments
    .filter((entry) => TAB_ID_RE.test(entry.tabId) && /^[a-z]+$/.test(entry.orderKey))
    .map((entry) => ({ id: entry.tabId, orderKey: entry.orderKey }))
  if (assignments.length !== cmd.assignments.length || assignments.length === 0) {
    warn('pin reorder rejected: invalid assignments', { count: cmd.assignments.length })
    return
  }
  if (!state.mainWindow) {
    warn('pin reorder dropped: no owner window')
    return
  }
  try {
    await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return false;
        store.getState().reorderPinnedTabs(${JSON.stringify(assignments)});
        return true;
      })()
    `)
    log('pin reorder applied', { assignment_count: assignments.length })
  } catch (err) {
    warn('pin reorder failed', { error: String(err) })
  }
}
