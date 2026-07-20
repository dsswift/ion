import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { RunOptions } from '../../shared/types'
import { log as _log, warn as _warn, setSessionContext } from '../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, lastMessagePreview, lastForwardedTabStatus, lastForwardedTabMeta, extensionCommandRegistry, DEBUG_MODE } from '../state'
import { terminalManager } from '../terminal-manager-instance'
import { evictAtvTab } from '../atv-state-cache'
import { notifyAtvUserMessageEcho } from '../atv-window-manager'
import { getRemoteTabStates } from '../remote/snapshot'
import { processIncomingPrompt } from '../prompt-pipeline'
import { parseSlash } from '../slash-parse'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
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
    log('retry_slash: slash command, setting resolve', { tab_id: tabId, command: slash.command })
    options.resolveSlash = true
  } else {
    log('retry_slash: not a slash command', { tab_id: tabId })
  }
}

export function registerSessionIpc(): void {
  ipcMain.handle(IPC.CREATE_TAB, () => {
    const tabId = sessionPlane.createTab()
    log('create_tab', { tab_id: tabId })

    if (state.remoteTransport) {
      getRemoteTabStates().then(({ tabs: tabStates }) => {
        const newTab = tabStates.find(t => t.id === tabId)
        if (newTab) {
          state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab })
        }
      }).catch((err) => warn('create_tab: remote tab-created notify failed', { tab_id: tabId, error: String(err) }))
    }

    return { tabId }
  })

  // ADOPT_TAB registers a tab under a caller-supplied (persisted) id instead of
  // minting one. The restore path uses this to reuse the durable tabId so the
  // session key is invariant across restarts and the engine binding store hits.
  // Idempotent in the control plane (adoptTab preserves an existing entry).
  ipcMain.handle(IPC.ADOPT_TAB, (_event, tabId: string) => {
    const adopted = sessionPlane.adoptTab(tabId)
    log('adopt_tab', { tab_id: adopted })

    if (state.remoteTransport) {
      getRemoteTabStates().then(({ tabs: tabStates }) => {
        const newTab = tabStates.find(t => t.id === adopted)
        if (newTab) {
          state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab })
        }
      }).catch((err) => warn('adopt_tab: remote tab-created notify failed', { tab_id: adopted, error: String(err) }))
    }

    return { tabId: adopted }
  })

  ipcMain.on(IPC.INIT_SESSION, (_event, tabId: string) => {
    log('init_session', { tab_id: tabId })
    sessionPlane.initSession(tabId)
  })

  // Eagerly ensure a live engine session for a normal tab (e.g. on restore /
  // reopen) so the conversation resumes under a stable key and is immediately
  // clearable, instead of being a sessionless shell until the first prompt.
  // Idempotent on the control-plane side (no-op when already started).
  ipcMain.handle(
    IPC.ENSURE_ENGINE_SESSION,
    async (_event, { tabId, workingDirectory, conversationId, permissionMode }: { tabId: string; workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan' }) => {
      log('ensure_engine_session', { tab_id: tabId, conversation_id: conversationId ?? 'none', dir: workingDirectory })
      const result = await sessionPlane.ensureSession(tabId, { workingDirectory, conversationId, permissionMode })
      // Stamp the logger context once the session is confirmed. tabId is the
      // desktop session_id (stable tab/session identifier); conversationId maps
      // to conversation_id when known.
      if (conversationId) {
        setSessionContext(tabId, conversationId)
      }
      return result
    },
  )

  ipcMain.on(IPC.RESET_TAB_SESSION, (_event, tabId: string) => {
    log('reset_tab_session', { tab_id: tabId })
    sessionPlane.resetTabSession(tabId)
  })

  // RESTART_TAB_SESSION power-cycles the engine session WITHOUT cutting a new
  // conversation (preserves conversationId). Used by stuck-tab recovery and
  // directory-change reconnect — a recoverable tab is turned off and on again,
  // not amputated. RESET_TAB_SESSION (above) is the destructive cut, reserved
  // for the Implement-plan clear-context flow.
  ipcMain.on(IPC.RESTART_TAB_SESSION, (_event, tabId: string) => {
    log('restart_tab_session: queuing stop', { tab_id: tabId })
    sessionPlane.restartTabSession(tabId)
    log('restart_tab_session: stop enqueued', { tab_id: tabId })
  })

  ipcMain.handle(IPC.PROMPT, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    // Mirror echo: the OWNER renderer does the optimistic transcript insert
    // in its own store; user turns never ride normalized events, so the ATV
    // mirror needs this push to show the message (whether it was typed in
    // the overlay, the ATV, or iOS — every prompt funnels through here).
    notifyAtvUserMessageEcho(tabId, options.prompt)
    if (DEBUG_MODE) {
      log('prompt', { tab_id: tabId, request_id: requestId, prompt: options.prompt.substring(0, 100) })
    } else {
      log('prompt', { tab_id: tabId, request_id: requestId })
    }

    if (!tabId) throw new Error('No tabId provided — prompt rejected')
    if (!requestId) throw new Error('No requestId provided — prompt rejected')

    if (!sessionPlane.hasTab(tabId)) {
      log('prompt: tab not found, auto-registering', { tab_id: tabId })
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
      log('prompt: error', { error: msg })
      throw err
    }
  })

  ipcMain.handle(IPC.CANCEL, (_event, requestId: string) => {
    log('cancel', { request_id: requestId })
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
      log('steer: not registered, dropping', { tab_id: tabId, len: message.length })
      return
    }
    log('steer', { tab_id: tabId, len: message.length })
    engineBridge.sendSteer(tabId, message)
  })

  ipcMain.handle(IPC.STOP_TAB, (_event, tabId: string) => {
    log('stop_tab', { tab_id: tabId })
    return sessionPlane.cancelTab(tabId)
  })

  ipcMain.handle(IPC.RETRY, async (_event, { tabId, requestId, options }: { tabId: string; requestId: string; options: RunOptions }) => {
    log('retry', { tab_id: tabId, request_id: requestId })
    markSlashForRetry(tabId, options)
    return sessionPlane.retry(tabId, requestId, options)
  })

  ipcMain.handle(IPC.STATUS, () => sessionPlane.getHealth())
  ipcMain.handle(IPC.TAB_HEALTH, () => sessionPlane.getHealth())

  ipcMain.handle(IPC.CLOSE_TAB, (_event, tabId: string) => {
    log('close_tab', { tab_id: tabId })
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
    lastForwardedTabMeta.delete(tabId)
    evictAtvTab(tabId)
    for (const key of extensionCommandRegistry.keys()) {
      if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
    }
  })

  // Renderer fires TAB_META_CHANGED whenever a tab field (title, customTitle,
  // groupId) changes. The main process pushes a lightweight desktop_tab_meta
  // delta to iOS immediately instead of waiting for the next 5 s snapshot poll.
  // Payload: { tabId, title?, runCostUsd?, totalCostUsd?, groupId? }
  ipcMain.on(IPC.TAB_META_CHANGED, (_event, payload: {
    tabId: string
    title?: string
    runCostUsd?: number
    totalCostUsd?: number
    groupId?: string | null
  }) => {
    if (!state.remoteTransport) return
    const { tabId, title, runCostUsd, totalCostUsd, groupId } = payload
    const delta: Record<string, unknown> = { type: 'desktop_tab_meta', tabId }
    if (title !== undefined) delta.title = title
    if (runCostUsd !== undefined) {
      delta.runCostUsd = runCostUsd
      // Keep totalCostUsd for lockstep iOS compatibility until iOS migrates.
      delta.totalCostUsd = runCostUsd
    } else if (totalCostUsd !== undefined) {
      delta.totalCostUsd = totalCostUsd
    }
    if (groupId !== undefined) delta.groupId = groupId
    log('tab_meta_changed: pushing desktop_tab_meta', { tab_id: tabId, title: title ?? '-', cost: runCostUsd ?? totalCostUsd ?? '-', group: groupId ?? '-' })
    state.remoteTransport.send(delta as any)
  })
}
