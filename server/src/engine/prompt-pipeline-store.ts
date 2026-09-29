/**
 * Side-effect helpers that mutate the store and talk to the remote
 * transport; called by the decision tree in `prompt-pipeline.ts` but not
 * part of its ordering invariants.
 *
 * Server-side counterpart of the desktop's `prompt-pipeline-renderer.ts`.
 * On the desktop, these reached the renderer's session store via
 * `executeJavaScript` because the main process held no direct store
 * reference. The server owns the store directly in this process, so every
 * helper here is a plain call into `useSessionStore.getState()` instead —
 * same store actions (`addEngineSystemMessage`, `insertRemoteUserMessage`,
 * `tabs`/`setState`), no window, no serialized JS string.
 */

import type { IncomingPrompt } from './prompt-pipeline'
import { log as _log, error as _error } from '../logger'
import { echoUserTurn } from '../user-turn-echo'
import { useSessionStore } from '../store/sessionStore'
import { sendRemoteEvent } from '../thin-view/remote-out'
import { releaseUnclaimedPromptDelivery } from '../remote/prompt-delivery'
import { traceFields } from '../tracing/prompt-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Insert a system-message bubble into the store's per-tab messages. Lets the
 * unified pipeline surface unknown-command feedback, extension-command
 * failures, and timeouts without going through an LLM round-trip. Routes
 * through `addEngineSystemMessage(tabId, content)`, which resolves the
 * active instance internally.
 */
export function insertRendererSystemMessage(p: IncomingPrompt, content: string): Promise<void> {
  try {
    const fn = (useSessionStore.getState() as unknown as { addEngineSystemMessage?: (tabId: string, content: string) => void }).addEngineSystemMessage
    fn?.(p.tabId, content)
  } catch (err) {
    log('prompt_pipeline: insertRendererSystemMessage error', { error: (err as Error).message })
  }
  return Promise.resolve()
}

/**
 * Insert a user-message bubble into the store for a remote-originated
 * prompt that bypassed the renderer's submit() path (the iOS slash
 * first-message case: an extension command that succeeds synchronously
 * starts a run without the store ever recording a user bubble for it).
 * Routes through `insertRemoteUserMessage(...)` on the store (which stamps
 * the prompt's clientMsgId, so a thin client's pending bubble finds the row),
 * then echoes to the Studio mirror via the funnel so the machine-authored
 * rule is applied once.
 */
export function insertRendererRemoteUserMessage(
  p: IncomingPrompt,
  content: string,
  slashCommand?: string,
  slashArgs?: string,
  implementationPhase?: boolean,
): Promise<void> {
  try {
    const fn = (useSessionStore.getState() as unknown as {
      insertRemoteUserMessage?: (tabId: string, content: string, slashCommand?: string, slashArgs?: string, implementationPhase?: boolean, clientMsgId?: string) => void
    }).insertRemoteUserMessage
    fn?.(p.tabId, content, slashCommand, slashArgs, implementationPhase, p.reqId)
  } catch (err) {
    log('insertRendererRemoteUserMessage error: ' + (err as Error).message)
  }
  log('insertRendererRemoteUserMessage: echoing to studio', { tab_id: p.tabId, content_len: content.length })
  echoUserTurn({ tabId: p.tabId, id: p.reqId, content, implementationPhase, injectionKind: p.injectionKind })
  return Promise.resolve()
}

/**
 * Restore a tab's status to idle when a slash-command dispatch finished
 * (success or failure) without producing a run. The store's
 * sendMessage/submitEnginePrompt path optimistically sets status='connecting'
 * for every prompt; when the unified pipeline determines the dispatch was a
 * pure command (no LLM turn coming), this actively clears that connecting
 * state. Never knocks a 'running' tab to idle — only 'connecting' resets.
 */
export function clearConnectingStatus(p: IncomingPrompt): Promise<void> {
  try {
    const store = useSessionStore
    const s = store.getState()
    store.setState({
      tabs: s.tabs.map((t) => {
        if (t.id !== p.tabId) return t
        if (t.status !== 'connecting') return t
        return { ...t, status: 'idle' as const }
      }),
    })
  } catch (err) {
    log('prompt_pipeline: clearConnectingStatus error', { error: (err as Error).message })
  }
  sendRemoteEvent({ type: 'desktop_tab_status', tabId: p.tabId, status: 'idle' })
  return Promise.resolve()
}

/**
 * Hand a remote-source prompt to the store's own submit path, in-process.
 *
 * A remote-source prompt (an iOS message, a Guided Questions resume prompt,
 * an implement-plan dispatch) is not submitted by the pipeline directly: the
 * store's submit does the optimistic user bubble, the status write, and the
 * auto-group move, then re-enters the pipeline as source='desktop'. The
 * server owns that store, so this is a plain call. An extension-backed tab
 * takes the unified `submit`; a plain tab takes `submitRemotePrompt`.
 *
 * Returns false when the store action is missing, throws, or refuses the
 * prompt, so the caller can report a prompt that went nowhere instead of
 * claiming a dispatch.
 */
export function submitRemotePromptToStore(p: IncomingPrompt): boolean {
  const text = p.attachmentPreparedText ?? p.text
  const attachments = p.attachments && p.attachments.length > 0 ? p.attachments : undefined
  const images = p.imageAttachments && p.imageAttachments.length > 0 ? p.imageAttachments : undefined
  const fields = {
    tab_id: p.tabId,
    req_id: p.reqId,
    engine: !!p.hasExtensions,
    text_len: text.length,
    raw_attachments: attachments?.length ?? 0,
    encoded_images: images?.length ?? 0,
    ...traceFields(p.traceparent),
  }
  try {
    const store = useSessionStore.getState()
    if (p.hasExtensions) {
      const result = store.submit(p.tabId, text, {
        displayText: p.displayText,
        publishUserTurn: p.publishUserTurn,
        appendSystemPrompt: p.appendSystemPrompt,
        imageAttachments: images,
        remoteAttachments: attachments,
        source: 'remote',
        resolveSlash: p.resolveSlash || undefined,
        requestId: p.reqId,
        implementationPhase: p.implementationPhase,
        injectionKind: p.injectionKind,
        traceparent: p.traceparent,
      })
      // The store refused it (a locked, connecting, or compacting
      // conversation), so it will never reach the engine. Tell whoever
      // submitted it now, with the store's own sentence, rather than leave
      // them waiting on an outcome that cannot come.
      if (result && !result.accepted) {
        log('pipeline: store refused the remote prompt', { ...fields, reason: result.reason })
        releaseUnclaimedPromptDelivery(p.reqId, { accepted: false, reason: result.message })
        return false
      }
    } else {
      store.submitRemotePrompt(
        p.tabId,
        text,
        images,
        p.resolveSlash,
        attachments,
        p.reqId,
        p.implementationPhase,
        p.injectionKind,
        p.displayText,
        p.publishUserTurn,
      )
    }
    log('pipeline: remote prompt handed to store submit', fields)
    return true
  } catch (err) {
    _error('main', 'pipeline: remote prompt store submit failed', { ...fields, error: (err as Error).message })
    return false
  }
}

/**
 * Run a device-typed `! command` through the store's bash path, which
 * records the user-executed bubble and streams the output into the tab.
 */
export function submitRemoteBashToStore(p: IncomingPrompt, command: string): boolean {
  try {
    useSessionStore.getState().submitRemoteBash(p.tabId, command, p.reqId)
    log('pipeline: remote bash handed to store', { tab_id: p.tabId, req_id: p.reqId, cmd_len: command.length })
    return true
  } catch (err) {
    _error('main', 'pipeline: remote bash store submit failed', { tab_id: p.tabId, req_id: p.reqId, error: (err as Error).message })
    return false
  }
}
