import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { RunOptions } from '../../shared/types'
import { log as _log } from '../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, lastMessagePreview, lastForwardedTabStatus, extensionCommandRegistry, DEBUG_MODE } from '../state'
import { terminalManager } from '../terminal-manager-instance'
import { getRemoteTabStates } from '../remote/snapshot'
import { processIncomingPrompt } from '../prompt-pipeline'
import { parseSlash } from '../slash-parse'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Mark a RETRY's RunOptions for engine-side slash resolution when the
 * retried prompt is a slash invocation.
 *
 * Fresh prompts route through processIncomingPrompt, which dispatches the
 * slash as an extension command and (on unknown_command) re-submits with
 * resolveSlash=true. Retried prompts skip the full pipeline because the user
 * has already made the routing decision once — but if the original prompt
 * was a slash, the engine still needs to be told to resolve + expand it
 * (otherwise the literal `/command args` string would be sent to the model).
 *
 * Local `.md` expansion is retired: the engine now OWNS slash resolution +
 * expansion (template lookup, $ARGUMENTS substitution, frontmatter), so the
 * desktop simply sets the resolveSlash flag and forwards the raw text. Both
 * branches are logged per desktop/AGENTS.md § Logging.
 */
function markSlashForRetry(tabId: string, options: RunOptions): void {
  const slash = parseSlash(options.prompt)
  if (slash) {
    log(`retrySlash: tab=${tabId} prompt is slash /${slash.command} → setting resolveSlash=true (engine resolves + expands)`)
    options.resolveSlash = true
  } else {
    log(`retrySlash: tab=${tabId} prompt is not a slash → no resolveSlash`)
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

  // ADOPT_TAB registers a tab under a caller-supplied (persisted) id instead of
  // minting one. The restore path uses this to reuse the durable tabId so the
  // session key is invariant across restarts and the engine binding store hits.
  // Idempotent in the control plane (adoptTab preserves an existing entry).
  ipcMain.handle(IPC.ADOPT_TAB, (_event, tabId: string) => {
    const adopted = sessionPlane.adoptTab(tabId)
    log(`IPC ADOPT_TAB → ${adopted}`)

    if (state.remoteTransport) {
      getRemoteTabStates().then(({ tabs: tabStates }) => {
        const newTab = tabStates.find(t => t.id === adopted)
        if (newTab) {
          state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab })
        }
      })
    }

    return { tabId: adopted }
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

  // RESTART_TAB_SESSION power-cycles the engine session WITHOUT cutting a new
  // conversation (preserves conversationId). Used by stuck-tab recovery and
  // directory-change reconnect — a recoverable tab is turned off and on again,
  // not amputated. RESET_TAB_SESSION (above) is the destructive cut, reserved
  // for the Implement-plan clear-context flow.
  ipcMain.on(IPC.RESTART_TAB_SESSION, (_event, tabId: string) => {
    log(`IPC RESTART_TAB_SESSION: ${tabId} — queuing stop_session to engine socket (FIFO; will arrive before resubmit's start_session)`)
    sessionPlane.restartTabSession(tabId)
    log(`IPC RESTART_TAB_SESSION: ${tabId} — stop_session enqueued; handler complete`)
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
        // Raw composer attachments -- encoded by the pipeline's desktop
        // branch (fs/nativeImage are main-process-only, so the renderer
        // could not encode them).
        attachments: options.rawAttachments,
        // DATA-derived: an extension-backed conversation carries its resolved
        // extension list in RunOptions (the unified renderer `submit` populates
        // it from the tab's profile); a plain CLI tab does not. There is no
        // separate engine prompt IPC any more — every tab funnels through PROMPT.
        hasExtensions: (options.extensions?.length ?? 0) > 0,
        projectPath: options.projectPath,
        runOptions: options,
        // Forward the engine-resolve-slash flag from RunOptions onto the
        // pipeline. When set (the iOS slash re-submit bounced back through the
        // renderer, or a retry of a slash prompt), the pipeline skips the
        // extension-command dispatch and submits the raw `/command args`
        // straight to the engine with resolveSlash=true — re-dispatching would
        // loop (the text is still a slash). See processIncomingPrompt.
        resolveSlash: options.resolveSlash,
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
    // Unified steer for EVERY conversation tab — plain or extension-backed
    // (the engine-vs-plain split was collapsed; there is no separate
    // ENGINE_STEER any more). Dispatch straight to engineBridge.sendSteer,
    // which emits the single `steer_agent` wire command with the bare tabId
    // as the session key.
    //
    // C1 GUARD: route through the tab-registry check. registerAdoptedTab (via
    // IPC.ADOPT_TAB) always completes before any tab is visible/interactive —
    // the renderer awaits adoptTab() before the tab object enters the store, so
    // no steer can arrive for an unregistered tab in normal flow. An unregistered
    // steer is a bug in the caller; log and drop instead of silently dispatching
    // a steer_agent command against an engine key with no backing session.
    if (!sessionPlane.hasTab(tabId)) {
      log(`IPC STEER: tab=${tabId} NOT registered in control plane — dropping steer (len=${message.length})`)
      return
    }
    log(`IPC STEER: tab=${tabId} len=${message.length}`)
    engineBridge.sendSteer(tabId, message)
  })

  ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
    log(`IPC STOP_TAB: ${tabId}`)
    return sessionPlane.cancelTab(tabId)
  })

  ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    log(`IPC RETRY: tab=${tabId} req=${requestId}`)
    markSlashForRetry(tabId, options)
    return sessionPlane.retry(tabId, requestId, options)
  })

  ipcMain.handle(IPC.STATUS, () => sessionPlane.getHealth())
  ipcMain.handle(IPC.TAB_HEALTH, () => sessionPlane.getHealth())

  ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
    log(`IPC CLOSE_TAB: ${tabId}`)
    sessionPlane.closeTab(tabId)
    terminalManager.destroyByPrefix(`${tabId}:`)
    // Conversations key their engine session by the bare tabId (ADR-010),
    // so stop that session directly. stopByPrefix(`${tabId}:`) only matches
    // compound keys (terminals, legacy `${tabId}:main`) and would otherwise
    // leave the bare-key conversation session orphaned.
    void engineBridge.stopSession(tabId)
    engineBridge.stopByPrefix(`${tabId}:`)

    if (state.remoteTransport) {
      state.remoteTransport.send({ type: 'desktop_tab_closed', tabId })
    }

    // Clean up all per-tab main-process state to prevent memory leaks.
    activeAssistantMessages.delete(tabId)
    lastMessagePreview.delete(tabId)
    lastForwardedTabStatus.delete(tabId)
    for (const key of extensionCommandRegistry.keys()) {
      if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
    }
  })
}
