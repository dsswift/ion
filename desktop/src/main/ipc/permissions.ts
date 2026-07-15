import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { sessionPlane } from '../state'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export function registerPermissionsIpc(): void {
  ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, { tabId, questionId, optionId }: { tabId: string; questionId: string; optionId: string }) => {
    log('respond_permission', { tab_id: tabId, question_id: questionId, option_id: optionId })
    return sessionPlane.respondToPermission(tabId, questionId, optionId)
  })

  ipcMain.handle(
    IPC.RESPOND_ELICITATION,
    (
      _event,
      { tabId, requestId, response, cancelled }:
        { tabId: string; requestId: string; response?: Record<string, unknown>; cancelled: boolean },
    ) => {
      log('respond_elicitation', { tab_id: tabId, request_id: requestId, cancelled })
      return sessionPlane.respondToElicitation(tabId, requestId, response, cancelled)
    },
  )

  ipcMain.handle(IPC.APPROVE_DENIED_TOOLS, (_event, { tabId, toolNames }: { tabId: string; toolNames: string[] }) => {
    log('approve_denied_tools', { tab_id: tabId, tools: toolNames.join(',') })
    sessionPlane.approveToolsForTab(tabId, toolNames)
  })
}
