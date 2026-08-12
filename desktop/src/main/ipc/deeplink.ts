import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { resolveDeepLinkConfirmation, markDeepLinkConfirmationReady, markDeepLinkConfirmationUnavailable } from '../deeplink/confirm'

function log(msg: string, fields?: Record<string, unknown>): void { _log('deeplink', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('deeplink', msg, fields) }

function owner(payload: unknown): 'overlay' | 'atv' | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as { owner?: unknown }).owner
  return value === 'overlay' || value === 'atv' ? value : null
}

export function registerDeepLinkIpc(): void {
  ipcMain.on(IPC.DEEPLINK_CONFIRM_READY, (_event, payload: unknown) => {
    const value = owner(payload)
    if (!value) { warn('confirmation ready ignored: invalid owner'); return }
    markDeepLinkConfirmationReady(value)
  })
  ipcMain.on(IPC.DEEPLINK_CONFIRM_UNAVAILABLE, (_event, payload: unknown) => {
    const value = owner(payload)
    if (!value) { warn('confirmation unavailable ignored: invalid owner'); return }
    markDeepLinkConfirmationUnavailable(value, 'renderer unavailable')
  })
  ipcMain.on(IPC.DEEPLINK_CONFIRM_RESULT, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) { warn('confirm result ignored: payload is not an object'); return }
    const { id, owner: resultOwner, approved, tabId } = payload as { id?: unknown; owner?: unknown; approved?: unknown; tabId?: unknown }
    if (typeof id !== 'string' || !id || id.length > 128) { warn('confirm result ignored: bad id'); return }
    if (resultOwner !== 'overlay' && resultOwner !== 'atv') { warn('confirm result ignored: invalid owner', { id }); return }
    if (typeof approved !== 'boolean') { warn('confirm result ignored: approved is not a boolean', { id }); return }
    if (tabId !== undefined && (typeof tabId !== 'string' || !tabId || tabId.length > 200)) { warn('confirm result ignored: bad tab id', { id }); return }
    log('confirm result received', { id, approved, owner: resultOwner })
    resolveDeepLinkConfirmation({ id, owner: resultOwner, approved, tabId })
  })
}
