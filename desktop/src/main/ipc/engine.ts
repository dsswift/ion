import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { engineBridge, sessionPlane } from '../state'

function log(msg: string): void {
  _log('main', msg)
}

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ENGINE_START, async (_event, { key, config }: { key: string; config: import('../../shared/types').EngineConfig }) => {
    log(`IPC ENGINE_START: key=${key} ext=${config.extensions?.join(',')}`)
    return engineBridge.startSession(key, config)
  })

  ipcMain.handle(IPC.ENGINE_PROMPT, async (_event, { key, text, model }: { key: string; text: string; model?: string }) => {
    log(`IPC ENGINE_PROMPT: key=${key} model=${model ?? 'default'}`)
    return engineBridge.sendPrompt(key, text, model)
  })

  ipcMain.handle(IPC.ENGINE_ABORT, (_event, { key }: { key: string }) => {
    log(`IPC ENGINE_ABORT: key=${key}`)
    engineBridge.sendAbort(key)
  })

  ipcMain.handle(
    IPC.ENGINE_ABORT_AGENT,
    (_event, { key, agentName, subtree }: { key: string; agentName: string; subtree?: boolean }) => {
      log(`IPC ENGINE_ABORT_AGENT: key=${key} agent=${agentName} subtree=${subtree ?? false}`)
      engineBridge.sendAbortAgent(key, agentName, subtree ?? false)
    },
  )

  ipcMain.handle(IPC.ENGINE_DIALOG_RESPONSE, (_event, { key, dialogId, value }: { key: string; dialogId: string; value: any }) => {
    log(`IPC ENGINE_DIALOG_RESPONSE: key=${key} dialog=${dialogId}`)
    engineBridge.sendDialogResponse(key, dialogId, value)
  })

  ipcMain.handle(IPC.ENGINE_COMMAND, (_event, { key, command, args }: { key: string; command: string; args: string }) => {
    log(`IPC ENGINE_COMMAND: key=${key} cmd=/${command}`)
    engineBridge.sendCommand(key, command, args)
  })

  ipcMain.handle(IPC.ENGINE_STOP, (_event, { key }: { key: string }) => {
    log(`IPC ENGINE_STOP: key=${key}`)
    engineBridge.stopSession(key)
  })

  ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, payload: { tabId: string; mode: string; source?: string }) => {
    const { tabId, mode, source } = payload
    if (mode !== 'auto' && mode !== 'plan') {
      log(`IPC SET_PERMISSION_MODE: invalid mode "${mode}" — ignoring`)
      return
    }
    log(`IPC SET_PERMISSION_MODE: tab=${tabId} mode=${mode} source=${source ?? 'unknown'}`)
    sessionPlane.setPermissionMode(tabId, mode, source)
  })
}
