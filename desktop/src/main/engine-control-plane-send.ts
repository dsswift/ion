/**
 * Prompt send with lost-session recovery — the tail half of
 * `EngineControlPlane.submitPrompt`.
 *
 * Extracted from `engine-control-plane.ts` to keep that file under the 600-line
 * TypeScript cap after the cwd reconciler was added to the prompt path. The
 * split is at a real seam rather than an arbitrary line: everything here runs
 * AFTER the session is guaranteed live and correctly located, and its single
 * concern is "get this prompt onto the wire, recovering once if the session
 * evaporated underneath us".
 *
 * ── Why the recovery exists ─────────────────────────────────────────────────
 * The engine can drop a session the desktop still believes in (daemon restart,
 * socket reconnect, eviction). The symptom is a `send_prompt` failure whose
 * error contains "not found". Rather than surface that to the operator as a
 * failed prompt, the desktop clears `engineSessionStarted`, routes a restart
 * through the SAME single start site (`ensureSession`) so the recovery cannot
 * drift from the normal start, and re-sends once.
 *
 * The retry deliberately drops `imageAttachments`: the first attempt already
 * carried them, and re-sending the base64 payload on a recovery path doubles
 * the request size for no benefit. This mirrors the behaviour the inline
 * version had before extraction.
 */
import type { EngineConfig, RunOptions, ThinkingConfig } from '../shared/types'
import type { TabEntry } from './engine-control-plane-events'
import type { EngineBridge } from './engine-bridge'

/** Result of a send attempt, mirroring `EngineBridge.sendPrompt`. */
export interface SendResult {
  ok: boolean
  error?: string
  data?: { accepted?: boolean; alreadyAccepted?: boolean }
}

/**
 * Adapt `RunOptions` to `EngineBridge.sendPrompt`'s named-options shape.
 *
 * The mapping is explicit rather than a spread: `RunOptions` carries fields
 * the wire has no business seeing (projectPath, sessionId, extensions), so
 * naming the forwarded set keeps the prompt payload deliberate.
 * `includeAttachments` is the one behavioural knob: false on the recovery
 * re-send.
 */
export function bridgeSendAdapter(bridge: EngineBridge) {
  return (tabId: string, opts: RunOptions, includeAttachments: boolean): Promise<SendResult> =>
    bridge.sendPrompt(tabId, opts.prompt, {
      model: opts.model,
      appendSystemPrompt: opts.appendSystemPrompt,
      imageAttachments: includeAttachments ? opts.imageAttachments : undefined,
      implementationPhase: opts.implementationPhase,
      enterPlanModeDescription: opts.enterPlanModeDescription,
      planModeSparseReminder: opts.planModeSparseReminder,
      planFilePath: opts.planFilePath,
      thinkingEffort: opts.thinkingEffort,
      resolveSlash: opts.resolveSlash,
      slashModelTierApplyMidConversation: opts.slashModelTierApplyMidConversation,
      clientWorkspaceContext: opts.clientWorkspaceContext,
      deliveryId: opts.deliveryId,
      displayText: opts.displayText,
      injectionKind: opts.injectionKind,
    })
}

/**
 * Dependencies the send needs. Injected rather than imported so this is
 * testable without a live bridge or control plane.
 */
export interface SendDeps {
  sendPrompt: (
    tabId: string,
    options: RunOptions,
    /** False on the recovery re-send: attachments already went with attempt 1. */
    includeAttachments: boolean,
  ) => Promise<SendResult>
  ensureSession: (
    tabId: string,
    opts: {
      workingDirectory: string
      conversationId?: string | null
      permissionMode?: 'auto' | 'plan'
      extensions?: string[]
      model?: string
      maxTokens?: number
      thinking?: ThinkingConfig
    },
  ) => Promise<SendResult>
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
}

/**
 * Send `options.prompt` for `tabId`, recovering once from a lost session.
 *
 * Returns the final result. The caller owns status transitions and error
 * emission — this function only sends and logs, so the recovery decision and
 * the UI consequence stay in separate places.
 */
export async function sendPromptWithRecovery(
  deps: SendDeps,
  tabId: string,
  tab: TabEntry,
  config: EngineConfig,
  options: RunOptions,
): Promise<SendResult> {
  const first = await deps.sendPrompt(tabId, options, true)

  if (first.ok || !first.error?.includes('not found')) {
    return first
  }

  deps.warn('send_prompt: session lost, re-creating', { tab_id: tabId })
  // Reset the started flag so ensureSession actually re-starts (it no-ops
  // when the flag is set). Route the recovery through the same single
  // start site rather than re-issuing startSession inline.
  tab.engineSessionStarted = false

  const startResult = await deps.ensureSession(tabId, {
    workingDirectory: config.workingDirectory,
    conversationId: config.sessionId ?? tab.conversationId,
    permissionMode: tab.permissionMode,
    extensions: config.extensions,
    model: config.model,
    maxTokens: config.maxTokens,
    thinking: config.thinking,
  })

  if (!startResult.ok) {
    deps.error('session re-create failed', { tab_id: tabId, error: startResult.error })
    return startResult
  }

  return deps.sendPrompt(tabId, options, false)
}
