import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { buildClearDividerRemoteEvent } from '../../shared/clear-divider'
import { log as _log } from '../logger'
import { engineBridge, sessionPlane, state } from '../state'
import { processIncomingPrompt } from '../prompt-pipeline'
import { encodeImageAttachments } from '../remote/attachment-encoder'

function log(msg: string): void {
  _log('main', msg)
}

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ENGINE_START, async (_event, { key, config }: { key: string; config: import('../../shared/types').EngineConfig }) => {
    log(`IPC ENGINE_START: key=${key} ext=${config.extensions?.join(',')}`)
    return engineBridge.startSession(key, config)
  })

  ipcMain.handle(IPC.ENGINE_PROMPT, async (_event, { key, text, model, appendSystemPrompt, imageAttachments, rawAttachments, implementationPhase }: { key: string; text: string; model?: string; appendSystemPrompt?: string; imageAttachments?: import('../../shared/types').ImageAttachmentPayload[]; rawAttachments?: import('../../shared/types-session').FileAttachment[]; implementationPhase?: boolean }) => {
    log(`IPC ENGINE_PROMPT: key=${key} model=${model ?? 'default'} hasSysPrompt=${!!appendSystemPrompt} images=${imageAttachments?.length ?? 0} rawAttachments=${rawAttachments?.length ?? 0} implementationPhase=${implementationPhase ?? false}`)
    // Encode raw file attachments when present (desktop InputBar path).
    // This mirrors the remote handler pattern at handlers/engine.ts:108-114.
    let resolvedText = text
    let resolvedImageAttachments = imageAttachments
    if (rawAttachments && rawAttachments.length > 0 && !imageAttachments?.length) {
      const ctx = rawAttachments.map((a) => `[Attached ${a.type}: ${a.path}]`).join('\n')
      resolvedText = `${ctx}\n\n${text}`
      const { encoded, rewrittenText } = encodeImageAttachments(resolvedText, rawAttachments)
      resolvedText = rewrittenText
      resolvedImageAttachments = encoded
    }
    // Route through the unified prompt pipeline so engine-tab slash commands
    // get the same precedence (extension command → .md → unknown) as CLI
    // tabs. The renderer's submitEnginePrompt already inserted the optimistic
    // user bubble and set status='running'; the pipeline will dispatch the
    // slash and (for pure-command success) clear status back to idle, or
    // (for a non-slash) submit the prompt to the engine bridge directly.
    //
    // Key shape: engine bridge keys are `${tabId}:${instanceId}` for engine
    // tabs. We split here to feed the pipeline its expected (tabId, instanceId)
    // pair. If there's no ':' the key IS the tabId (defensive — shouldn't
    // happen for engine tabs in practice).
    const [tabId, instanceId] = key.includes(':') ? key.split(':', 2) : [key, null]
    const reqId = `desktop-engine-${Date.now()}`

    // Resolve planFilePath from the renderer store so the engine can
    // restore the plan file after a desktop restart instead of
    // allocating a fresh slug. Mirrors the projectPath resolution
    // pattern in remote/handlers/engine.ts.
    let planFilePath: string | undefined
    try {
      const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const pfp = await state.mainWindow?.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
          return tab && tab.planFilePath ? tab.planFilePath : null;
        })()
      `)
      planFilePath = pfp || undefined
    } catch (err) {
      log(`IPC ENGINE_PROMPT: planFilePath query failed key=${key}: ${(err as Error).message}`)
    }

    try {
      await processIncomingPrompt({
        tabId,
        text: resolvedText,
        reqId,
        source: 'desktop',
        isEngineTab: true,
        instanceId,
        appendSystemPrompt,
        model,
        imageAttachments: resolvedImageAttachments,
        implementationPhase,
        planFilePath,
      })
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`IPC ENGINE_PROMPT: pipeline error key=${key} err=${msg}`)
      return { ok: false, error: msg }
    }
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
    // Mirror /clear divider to iOS so the remote client sees the checkpoint
    // immediately, without waiting for a conversation reload. The renderer
    // has already inserted the divider into its local message store via
    // addSystemMessage / addEngineSystemMessage; here we relay it to iOS.
    // The envelope kind (engine_harness_message vs. message_added) is keyed
    // by the engine session key shape — see buildClearDividerRemoteEvent.
    if (command === 'clear' && state.remoteTransport) {
      state.remoteTransport.send(buildClearDividerRemoteEvent(key, new Date()))
    }
  })

  ipcMain.handle(IPC.ENGINE_STOP, (_event, { key }: { key: string }) => {
    log(`IPC ENGINE_STOP: key=${key}`)
    engineBridge.stopSession(key)
  })

  ipcMain.handle(IPC.ENGINE_REMAP_SESSION, (_event, { oldKey, newKey }: { oldKey: string; newKey: string }) => {
    log(`IPC ENGINE_REMAP_SESSION: ${oldKey} -> ${newKey}`)
    engineBridge.remapSession(oldKey, newKey)
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

  ipcMain.on('ion:engine-set-plan-mode', (_event, key: string, enabled: boolean) => {
    log(`IPC engine-set-plan-mode: key=${key} enabled=${enabled}`)
    engineBridge.sendSetPlanMode(key, enabled, undefined, 'prompt_sync')
  })
}
