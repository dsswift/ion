import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { RunOptions } from '../../shared/types'
import { log as _log } from '../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, activeToolInputs, lastMessagePreview, lastForwardedEngineTabStatus, extensionCommandRegistry, DEBUG_MODE } from '../state'
import { terminalManager } from '../terminal-manager-instance'
import { getRemoteTabStates } from '../remote/snapshot'
import { expandSlashCommand } from '../cli-compat/slash-expand'
import { readSettings, SETTINGS_DEFAULTS } from '../settings-store'
import { broadcast } from '../broadcast'
import { processIncomingPrompt } from '../prompt-pipeline'
import { isFirstPromptForTab } from '../slash-classify'

function log(msg: string): void {
  _log('main', msg)
}

/** Expand slash commands in-place on RunOptions when claudeCompat is enabled.
 *  Used ONLY by the RETRY path now — fresh prompts route through
 *  processIncomingPrompt which has its own (richer) slash-routing logic.
 *  Retried prompts skip the full pipeline because the user has already made
 *  the routing decision once (the slash-or-not classification doesn't change
 *  on retry); we only need the .md expansion behaviour preserved here.
 *  When a command file is found, auto-switches the tab from plan → auto so
 *  the expanded command executes immediately instead of being planned about. */
async function applySlashExpansion(tabId: string, options: RunOptions): Promise<void> {
  let claudeCompat = SETTINGS_DEFAULTS.enableClaudeCompat
  try {
    const s = readSettings()
    claudeCompat = s.enableClaudeCompat ?? claudeCompat
  } catch { /* use default */ }
  if (!claudeCompat) {
    log(`slashExpand: claudeCompat disabled, skipping`)
    return
  }

  const expansion = await expandSlashCommand(options.prompt, options.projectPath)
  if (expansion.expanded) {
    log(`slashExpand: expanded "${options.prompt.substring(0, 50)}" → systemPrompt=${expansion.systemPrompt.length}chars userPrompt="${expansion.userPrompt.substring(0, 50)}"`)
    options.prompt = expansion.userPrompt
    options.appendSystemPrompt = options.appendSystemPrompt
      ? options.appendSystemPrompt + '\n\n' + expansion.systemPrompt
      : expansion.systemPrompt
    // Auto-switch plan → auto only for the first prompt. Retries inherently
    // have promptCount > 0 (the original prompt was already submitted), so
    // this guard always prevents the switch on the retry path — which is
    // correct: a retry should preserve whatever permission mode the tab is
    // currently in rather than forcing it back to auto.
    // Also blocked when options.sessionId is set (resumed conversation).
    if (isFirstPromptForTab(tabId, options.sessionId)) {
      sessionPlane.setPermissionMode(tabId, 'auto', 'slash_command')
      broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId, mode: 'auto' })
    } else {
      log(`slashExpand: skipping plan→auto switch for tabId=${tabId} — conversation already active (promptCount=${sessionPlane.getTabStatus(tabId)?.promptCount ?? '?'})`)
    }
  } else {
    log(`slashExpand: no expansion for "${options.prompt.substring(0, 50)}"`)
  }
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.CREATE_TAB, () => {
    const tabId = sessionPlane.createTab()
    log(`IPC CREATE_TAB → ${tabId}`)

    if (state.remoteTransport) {
      getRemoteTabStates().then(({ tabs: tabStates }) => {
        const newTab = tabStates.find(t => t.id === tabId)
        if (newTab) {
          state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab })
        }
      })
    }

    return { tabId }
  })

  ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
    log(`IPC INIT_SESSION: ${tabId}`)
    sessionPlane.initSession(tabId)
  })

  // Eagerly ensure a live engine session for a normal tab (e.g. on restore /
  // reopen) so the conversation resumes under a stable key and is immediately
  // clearable, instead of being a sessionless shell until the first prompt.
  // Idempotent on the control-plane side (no-op when already started).
  ipcMain.handle(
    IPC.ENSURE_ENGINE_SESSION,
    async (_event, { tabId, workingDirectory, conversationId, permissionMode }: { tabId: string; workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan' }) => {
      log(`IPC ENSURE_ENGINE_SESSION: tab=${tabId} conversationId=${conversationId ?? 'none'} dir=${workingDirectory}`)
      return sessionPlane.ensureSession(tabId, { workingDirectory, conversationId, permissionMode })
    },
  )

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

    // Echo the user's typed text to iOS so a desktop-initiated prompt is
    // visible there too. Skip for remote-source because iOS already inserted
    // the optimistic entry locally and the pipeline will echo back to it.
    if (state.remoteTransport && options.source !== 'remote') {
      state.remoteTransport.send({
        type: 'desktop_message_added',
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
      // Hand off to the unified prompt pipeline. The pipeline decides:
      //   - bash shortcut (! prefix, remote-source only)
      //   - slash → extension command → .md expansion → unknown-command
      //   - normal prompt → sessionPlane.submitPrompt(...)
      // Slash routing is no longer duplicated in the renderer or remote
      // handler — both now hand raw text here.
      //
      // Source is always 'desktop' here: IPC.PROMPT is the sink for the
      // remote→broadcast→renderer→IPC roundtrip. The renderer has already
      // done the optimistic insert and set status='connecting'. If we
      // forwarded options.source='remote' to the pipeline, submitAsPrompt
      // would re-broadcast REMOTE_USER_MESSAGE, the renderer would bail on
      // the connecting status, and sessionPlane.submitPrompt would never
      // run — the tab would sit idle until the watchdog reaps it. The
      // echo-skip above keeps using options.source so iOS isn't double-echoed.
      await processIncomingPrompt({
        tabId,
        text: options.prompt,
        reqId: requestId,
        source: 'desktop',
        isEngineTab: false,
        projectPath: options.projectPath,
        runOptions: options,
      })
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

  ipcMain.on(IPC.STEER, (_event, { tabId, message }: { tabId: string; message: string }) => {
    log(`IPC STEER: tab=${tabId}`)
    sessionPlane.steerSession(tabId, message)
  })

  ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
    log(`IPC STOP_TAB: ${tabId}`)
    return sessionPlane.cancelTab(tabId)
  })

  ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    log(`IPC RETRY: tab=${tabId} req=${requestId}`)
    await applySlashExpansion(tabId, options)
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
      state.remoteTransport.send({ type: 'desktop_tab_closed', tabId })
    }

    // Clean up all per-tab main-process state to prevent memory leaks.
    activeAssistantMessages.delete(tabId)
    activeToolInputs.delete(tabId)
    lastMessagePreview.delete(tabId)
    lastForwardedEngineTabStatus.delete(tabId)
    for (const key of extensionCommandRegistry.keys()) {
      if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
    }
  })
}
