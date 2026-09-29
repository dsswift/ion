/**
 * Dialog-response seam of `EngineControlPlane`: the two answers a human gives
 * back to a waiting run — a permission decision and an elicitation reply.
 *
 * Extracted from engine-control-plane.ts to keep it under the 600-line
 * TypeScript cap. They belong together and apart from the rest: both are
 * inbound answers rather than lifecycle or dispatch, both refuse an unknown tab
 * the same way, and the permission path owns the cross-surface reconcile that
 * is the only reason the control plane knows about the Studio window at all.
 * Isolating that here keeps the studio dependency off the main class file.
 */
import { log as _log } from '../logger'
import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'
import { resolveStudioPermission } from './studio-state-cache'
import type { NormalizedEvent } from '@ion/shared/types'
import {
  SETTINGS_GUARD_ALLOW, SETTINGS_GUARD_DENY, grantSettingsEdit, isSettingsGuardQuestion,
  takeSettingsGuardQuestion, type SettingsGuardQuestion,
} from './settings-files-guard'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * Deliver a permission answer and reconcile every other surface showing it.
 *
 * `onResolved` is called after the answer is sent, with the tab and question
 * ids. The control plane emits its `permission-resolved` event from there
 * rather than this module importing the studio window manager directly:
 * engine-control-plane → studio-window-manager → state → engine-control-plane
 * is a module cycle that only loads by import-order luck.
 *
 * Returns false for an unknown tab, logging the drop — an answer that reaches
 * no session must not look the same as one that was delivered.
 */
export function respondToPermission(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  questionId: string,
  optionId: string,
  onResolved: (tabId: string, questionId: string) => void,
): boolean {
  if (!tabs.has(tabId)) {
    log('respond_to_permission: dropped, unknown tab', { tab_id: tabId, question_id: questionId })
    return false
  }
  if (isSettingsGuardQuestion(questionId)) {
    // This server asked the question (settings-files-guard), so this server
    // takes the answer. The engine never saw it and must not be sent it.
    answerSettingsGuard(tabId, questionId, optionId)
  } else {
    bridge.sendPermissionResponse(tabId, questionId, optionId)
  }
  // Cross-surface reconcile (mirror-store architecture): this is the ONE spot
  // every surface's answer funnels through — overlay card, iOS remote, Studio
  // approval. Resolving the Studio window pending queue and pushing the
  // resolution here means an answer from ANY surface clears the others
  // instantly, instead of waiting for the next status transition.
  resolveStudioPermission(tabId, questionId)
  onResolved(tabId, questionId)
  return true
}

/** Deliver an elicitation reply. Returns false for an unknown tab. */
export function respondToElicitation(
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  tabId: string,
  requestId: string,
  response: Record<string, unknown> | undefined,
  cancelled: boolean,
  declined: boolean,
): boolean {
  if (!tabs.has(tabId)) {
    log('respond_to_elicitation: dropped, unknown tab', { tab_id: tabId, request_id: requestId, cancelled })
    return false
  }
  bridge.sendElicitationResponse(tabId, requestId, response, cancelled, declined)
  return true
}

/** Emits the control plane's own events; the same two a permission request from the engine produces. */
type PlaneEmit = (eventName: string, ...args: unknown[]) => void

/**
 * Put a settings-file approval to the person at the conversation, through the
 * same permission card an engine permission request uses, so every surface
 * (Studio and the phone) shows it and any of them can answer.
 */
export function askSettingsEdit(emit: PlaneEmit, question: SettingsGuardQuestion): void {
  const options = [
    { id: SETTINGS_GUARD_ALLOW, label: 'Allow in this conversation', kind: 'allow' },
    { id: SETTINGS_GUARD_DENY, label: 'Deny', kind: 'deny' },
  ]
  const toolName = `Edit settings file (${question.toolName})`
  const toolInput = { ...question.toolInput, settingsFile: question.path }
  log('settings edit approval asked', { tab_id: question.tabId, question_id: question.questionId, path: question.path, tool: question.toolName })
  emit('event', question.tabId, {
    type: 'permission_request',
    questionId: question.questionId,
    toolName,
    toolDescription: `The agent wants to change ${question.path}, a settings file of this server.`,
    toolInput,
    options,
  } as NormalizedEvent)
  emit('remote-permission', question.tabId, { questionId: question.questionId, toolName, toolInput, options })
}

/** Called once a settings-file approval is answered, so the conversation can be told. */
type SettingsGuardAnswered = (question: SettingsGuardQuestion, approved: boolean) => void
let onSettingsGuardAnswered: SettingsGuardAnswered | null = null

/** Registered by the prompt pipeline, which owns telling a conversation something. */
export function registerSettingsGuardAnswered(handler: SettingsGuardAnswered): void {
  onSettingsGuardAnswered = handler
}

function answerSettingsGuard(tabId: string, questionId: string, optionId: string): void {
  const question = takeSettingsGuardQuestion(questionId)
  if (!question) {
    log('settings edit answer dropped: unknown question', { tab_id: tabId, question_id: questionId })
    return
  }
  const approved = optionId === SETTINGS_GUARD_ALLOW
  if (approved) grantSettingsEdit(question.tabId, question.path)
  log('settings edit approval answered', { tab_id: tabId, question_id: questionId, path: question.path, approved })
  if (onSettingsGuardAnswered) onSettingsGuardAnswered(question, approved)
  else log('settings edit answer not relayed: no handler registered', { tab_id: tabId, question_id: questionId })
}
