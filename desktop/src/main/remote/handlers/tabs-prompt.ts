import { existsSync, readFileSync } from 'fs'
import { log as _log } from '../../logger'
import { state, sessionPlane, engineBridge } from '../../state'
import { processIncomingPrompt } from '../../prompt-pipeline'
import { encodeAttachments } from '../attachment-encoder'
import { IS_REMOTE } from '../../engine-bridge'
import { getVoiceSystemPrompt } from './engine'
import { performUnifiedInterrupt } from '../../engine-control-plane-interrupt'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Resolve the working directory the renderer has stored for a given tab.
 * Used by handlePrompt to feed the unified prompt pipeline a projectPath
 * for `.md` template expansion — without it, `.md` lookup would only
 * search `~/.claude/commands/` and miss project-scoped commands at
 * `${cwd}/.claude/commands/`. Returns undefined when the tab isn't found
 * or mainWindow isn't ready (defensive — in that case the pipeline still
 * runs, just without project-scoped `.md` discovery).
 */
export async function resolveTabProjectPath(tabId: string): Promise<string | undefined> {
  if (!state.mainWindow) return undefined
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const cwd = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
        return tab && tab.workingDirectory ? tab.workingDirectory : null;
      })()
    `)
    return cwd || undefined
  } catch (err) {
    log(`resolveTabProjectPath: error tab=${tabId}: ${(err as Error).message}`)
    return undefined
  }
}

export async function handlePrompt(cmd: Extract<RemoteCommand, { type: 'desktop_prompt' }>, deviceId: string): Promise<void> {
  const reqId = cmd.clientMsgId || `remote-${Date.now()}`

  // When instanceId is present the iOS client is targeting an engine-hosted
  // conversation (merged from the former desktop_engine_prompt path). Detect
  // this here so we can choose the right pipeline branch below.
  const isEnginePrompt = cmd.instanceId !== undefined && cmd.instanceId !== null

  if (isEnginePrompt) {
    // ── Engine tab path (formerly handleEnginePrompt) ──────────────────
    if (!state.mainWindow) {
      log('handlePrompt (engine): no mainWindow, ignoring')
      return
    }
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

    // Resolve the active instance from the renderer store.
    // If no instance exists yet (EngineView hasn't mounted), create one.
    let instanceId: string | null = cmd.instanceId || await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var pane = store.getState().conversationPanes.get('${escapedTab}');
        return pane && pane.activeInstanceId ? pane.activeInstanceId : null;
      })()
    `)

    if (!instanceId) {
      log('handlePrompt (engine): no instance exists, auto-creating one')
      instanceId = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          return store.getState().addEngineInstance('${escapedTab}');
        })()
      `)
      if (!instanceId) {
        log('handlePrompt (engine): failed to create engine instance')
        return
      }
      // Notify iOS about the new instance
      const instanceInfo = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var pane = store.getState().conversationPanes.get('${escapedTab}');
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === '${instanceId!.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'; });
          return inst ? { id: inst.id, label: inst.label } : null;
        })()
      `)
      if (instanceInfo) {
        state.remoteTransport?.send({
          type: 'desktop_instance_added',
          tabId: cmd.tabId,
          instance: instanceInfo,
        })
      }
      // Send the initial model override so iOS knows the configured model
      const escapedInstId = instanceId!.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const modelOverride = await state.mainWindow.webContents.executeJavaScript(
        `window.__Ion_resolveEngineModel('${escapedTab}')`
      )
      if (modelOverride) {
        state.remoteTransport?.send({
          type: 'desktop_model_override',
          tabId: cmd.tabId,
          instanceId,
          model: modelOverride,
        })
      }
      // Wait for the engine session to initialise before sending the prompt
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    // Image-attachment encoding for engine tabs (engine bridge takes
    // already-encoded ImageAttachmentPayload[]).
    let fullText = cmd.text
    const attachments = cmd.attachments || []
    if (attachments.length > 0) {
      const ctx = attachments.map((a) => `[Attached ${a.type}: ${a.path}]`).join('\n')
      fullText = `${ctx}\n\n${fullText}`
    }
    const { encoded, rewrittenText } = encodeAttachments(fullText, attachments, { isRemote: IS_REMOTE })
    const voicePrompt = getVoiceSystemPrompt(deviceId)
    // Reuse the iOS-supplied clientMsgId as the engine request id so the
    // user-message echo (below) carries this exact id back to iOS. iOS reconciles
    // its optimistic user bubble by id and replaces it in place — without a
    // shared id the optimistic insert and the canonical user turn would both
    // render (duplicate). Mirrors the CLI branch's `reqId = cmd.clientMsgId || …`
    // below. Falls back to a fresh id for desktop-originated prompts that carry
    // no clientMsgId.
    const engineReqId = cmd.clientMsgId || `remote-engine-${Date.now()}`

    // Echo the user's message back to iOS under engineReqId so the optimistic
    // bubble reconciles by id immediately, matching the CLI branch. The engine
    // path previously sent NO live user echo — the user turn only re-arrived via
    // the next desktop_conversation_history reload (a different, engine-assigned
    // id), so the optimistic UUID bubble and the reloaded turn both rendered
    // until the reload's dedup collapsed them (the "doubles until you leave and
    // come back" symptom). We send the attachment-marker content (fullText) so
    // the iOS bubble renders the same inline attachment previews the optimistic
    // insert built. `content` here is what iOS displays after reconciliation.
    //
    // Slash-command provenance: when the raw prompt (cmd.text) is a slash
    // invocation, carry the parsed command/args so iOS renders the pill from
    // metadata rather than relying on fallback content parsing (which breaks
    // when the history reload delivers the expanded body as content).
    const slashMatch = cmd.text.match(/^\/([a-zA-Z][a-zA-Z0-9_:-]*)\s*([\s\S]*)$/)
    state.remoteTransport?.send({
      type: 'desktop_message_added',
      tabId: cmd.tabId,
      message: {
        id: engineReqId, role: 'user', content: fullText, timestamp: Date.now(), source: 'remote',
        ...(slashMatch ? { slashCommand: `/${slashMatch[1]}`, slashArgs: slashMatch[2] } : {}),
      },
    })

    // Resolve project path from renderer (same query as CLI path below).
    let projectPath: string | undefined
    try {
      const cwd = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
          return tab && tab.workingDirectory ? tab.workingDirectory : null;
        })()
      `)
      projectPath = cwd || undefined
    } catch (err) {
      log(`handlePrompt (engine): project-path query failed for tab=${cmd.tabId}: ${(err as Error).message}`)
    }

    // Resolve planFilePath from renderer store.
    let planFilePath: string | undefined
    try {
      const pfp = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
          return tab && tab.planFilePath ? tab.planFilePath : null;
        })()
      `)
      planFilePath = pfp || undefined
    } catch (err) {
      log(`handlePrompt (engine): planFilePath query failed for tab=${cmd.tabId}: ${(err as Error).message}`)
    }

    await processIncomingPrompt({
      tabId: cmd.tabId,
      text: rewrittenText,
      attachments,
      imageAttachments: encoded.length > 0 ? encoded : undefined,
      reqId: engineReqId,
      source: 'remote',
      hasExtensions: true,
      instanceId,
      appendSystemPrompt: voicePrompt,
      projectPath,
      implementationPhase: cmd.implementationPhase,
      planFilePath,
    })
    return
  }

  // ── CLI tab path (original handlePrompt) ──────────────────────────────
  // Echo the user's typed text back to iOS with a canonical ms timestamp so
  // iOS replaces its optimistic entry by id (fixing the "56 years ago"
  // symptom that motivated the pipeline refactor). For non-slash text the
  // pipeline still goes through this echo before broadcasting to the
  // renderer; for slash text the pipeline handles the echo itself in
  // handleSlash().
  //
  // We do the echo here UNCONDITIONALLY for normal prompts because the
  // pipeline only echoes from handleSlash() (and from clearConnectingStatus
  // for terminal command outcomes). The redundancy is intentional: a normal
  // remote prompt has no "command outcome" event to anchor an echo on, so
  // we echo at the entry point. Slash echoes inside the pipeline are extra
  // confirmations, not the only ones — but for the non-slash path this
  // echo is the only one.
  const cliSlashMatch = cmd.text.match(/^\/([a-zA-Z][a-zA-Z0-9_:-]*)\s*([\s\S]*)$/)
  state.remoteTransport?.send({
    type: 'desktop_message_added',
    tabId: cmd.tabId,
    message: {
      id: reqId, role: 'user', content: cmd.text, timestamp: Date.now(), source: 'remote',
      ...(cliSlashMatch ? { slashCommand: `/${cliSlashMatch[1]}`, slashArgs: cliSlashMatch[2] } : {}),
    },
  })
  // Resolve the tab's working directory from the renderer store so the
  // pipeline can find project-scoped `.md` templates (e.g.
  // ${cwd}/.claude/commands/ion--review-changes.md). The renderer is the
  // authoritative source for per-tab cwd; sessionPlane only stores it
  // implicitly via the most recent submitPrompt. Awaiting this query is
  // cheap (single executeJavaScript round-trip) and the work-in-flight
  // overlap with the engine dispatch is unavoidable anyway.
  const projectPath = await resolveTabProjectPath(cmd.tabId)
  // Fire-and-forget the unified pipeline. Errors are logged inside the
  // pipeline; we never want a thrown error here to crash the transport.
  void processIncomingPrompt({
    tabId: cmd.tabId,
    text: cmd.text,
    attachments: cmd.attachments,
    reqId,
    source: 'remote',
    hasExtensions: false,
    projectPath,
    implementationPhase: cmd.implementationPhase,
  }).catch((err: unknown) => {
    log(`handlePrompt: pipeline error: ${(err as Error).message}`)
  })
}

export function handleCancel(cmd: Extract<RemoteCommand, { type: 'desktop_cancel' }>): void {
  if (!sessionPlane.cancelTab(cmd.tabId)) {
    log(`remote cancel: tab ${cmd.tabId} not in sessionPlane, performing unified interrupt directly`)
    // Mirror cancelTab's unified interrupt on the not-in-plane fallback path:
    // abort the parent run AND reap the dispatched-agent subtree. Otherwise a
    // cancel that misses the session plane (e.g. a tab the control plane doesn't
    // track) leaves background agents running.
    performUnifiedInterrupt(engineBridge, cmd.tabId)
  }
}
