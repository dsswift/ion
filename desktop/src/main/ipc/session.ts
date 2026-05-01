import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { RunOptions } from '../../shared/types'
import { log as _log } from '../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, DEBUG_MODE } from '../state'
import { terminalManager } from '../terminal-manager-instance'
import { getRemoteTabStates } from '../remote/snapshot'

function log(msg: string): void {
  _log('main', msg)
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.CREATE_TAB, () => {
    const tabId = sessionPlane.createTab()
    log(`IPC CREATE_TAB → ${tabId}`)

    if (state.remoteTransport) {
      getRemoteTabStates().then(tabStates => {
        const newTab = tabStates.find(t => t.id === tabId)
        if (newTab) {
          state.remoteTransport?.send({ type: 'tab_created', tab: newTab })
        }
      })
    }

    return { tabId }
  })

  ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
    log(`IPC INIT_SESSION: ${tabId}`)
    sessionPlane.initSession(tabId)
  })

  ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
    log(`IPC RESET_TAB_SESSION: ${tabId}`)
    sessionPlane.resetTabSession(tabId)
  })

  ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    if (DEBUG_MODE) {
      log(`IPC PROMPT: tab=${tabId} req=${requestId} prompt="${options.prompt.substring(0, 100)}"`)
    } else {
      log(`IPC PROMPT: tab=${tabId} req=${requestId}`)
    }

    if (!tabId) throw new Error('No tabId provided — prompt rejected')
    if (!requestId) throw new Error('No requestId provided — prompt rejected')

    if (!sessionPlane.hasTab(tabId)) {
      log(`PROMPT: tab ${tabId} not found — auto-registering`)
      sessionPlane.ensureTab(tabId)
    }

    if (state.remoteTransport && options.source !== 'remote') {
      state.remoteTransport.send({
        type: 'message_added',
        tabId,
        message: {
          id: requestId,
          role: 'user',
          content: options.prompt,
          timestamp: Date.now(),
          source: 'desktop',
        },
      })
    }

    try {
      await sessionPlane.submitPrompt(tabId, requestId, options)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`PROMPT error: ${msg}`)
      throw err
    }
  })

  ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
    log(`IPC CANCEL: ${requestId}`)
    return sessionPlane.cancel(requestId)
  })

  ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
    log(`IPC STOP_TAB: ${tabId}`)
    return sessionPlane.cancelTab(tabId)
  })

  ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    log(`IPC RETRY: tab=${tabId} req=${requestId}`)
    return sessionPlane.retry(tabId, requestId, options)
  })

  ipcMain.handle(IPC.STATUS, () => sessionPlane.getHealth())
  ipcMain.handle(IPC.TAB_HEALTH, () => sessionPlane.getHealth())

  ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
    log(`IPC CLOSE_TAB: ${tabId}`)
    sessionPlane.closeTab(tabId)
    terminalManager.destroyByPrefix(`${tabId}:`)
    engineBridge.stopByPrefix(`${tabId}:`)

    if (state.remoteTransport) {
      state.remoteTransport.send({ type: 'tab_closed', tabId })
    }

    activeAssistantMessages.delete(tabId)
  })
}
