import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { sessionPlane } from '../state'

function log(msg: string): void {
  _log('main', msg)
}

export function registerPermissionsIpc(): void {
  ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
    log(`IPC RESPOND_PERMISSION: tab=${tabId} question=${questionId} option=${optionId}`)
    return sessionPlane.respondToPermission(tabId, questionId, optionId)
  })

  ipcMain.handle(IPC.APPROVE_DENIED_TOOLS, (_event, { tabId, toolNames }: { tabId: string; toolNames: string[] }) => {
    log(`IPC APPROVE_DENIED_TOOLS: tab=${tabId} tools=${toolNames.join(',')}`)
    sessionPlane.approveToolsForTab(tabId, toolNames)
  })
}
