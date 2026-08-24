/**
 * Questions wiring — connects the QuestionsCoordinator (the ONE workflow
 * owner in main) to its transports under the PARK/RESUME architecture:
 *
 *   - engine intake: parked AskUserQuestions denials arrive on
 *     engine_status idles (fields.permissionDenials), exactly like
 *     AskUserQuestion / ExitPlanMode. The coordinator opens (or
 *     re-confirms) a workflow per denial toolUseId.
 *   - submission: the operator's answers become a REAL resume prompt sent
 *     through processIncomingPrompt — the same pipeline every prompt uses —
 *     with any per-answer image attachments riding the normal attachment
 *     path. requestMore instructs the model to call AskUserQuestions again
 *     with the workflowId.
 *   - supersession: any non-questions prompt on the session retires its
 *     parked workflows (the engine clears retained denials on a new prompt,
 *     so the question can no longer resume — identical to the
 *     AskUserQuestion card lifetime).
 *   - fan-out: broadcast() to both desktop windows and
 *     desktop_questions_state to iOS, plus the per-request APNs doorbell
 *     (always with { tabId } push metadata).
 *   - renderer IPC: get-state / revisioned patch / action.
 *   - iOS remote commands: desktop_questions_patch/_action/_refresh.
 *
 * Called once at startup (ipc/register.ts).
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'path'
import { IPC } from '../../shared/types'
import type { EngineEvent } from '../../shared/types'
import type { QuestionsAction, QuestionsPatch, QuestionsStateSnapshot, QuestionsWorkflowState } from '../../shared/questions-state'
import { QuestionsCoordinator } from './questions-coordinator'
import type { TranscriptRow } from './questions-rehydrate'
import { buildQuestionsResumePrompt } from './questions-resume-prompt'
import { broadcast } from '../broadcast'
import { state } from '../state'
import { showWindow } from '../window-manager'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'questions-wiring'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Bridge surface the wiring needs (event subscription only). */
interface QuestionsWiringBridge {
  on(event: 'event', listener: (key: string, event: EngineEvent) => void): unknown
}

let coordinator: QuestionsCoordinator | null = null

/** The live coordinator (snapshot merging, Inbox guards). Null before wiring. */
export function questionsCoordinator(): QuestionsCoordinator | null {
  return coordinator
}

/**
 * Marks the reqIds of resume prompts this module dispatched, so the
 * prompt-dispatch observer can tell "our submission" from "a foreign prompt
 * that supersedes the parked question". Value is the insertion time: a
 * questions prompt re-enters the pipeline once (remote-source bounce through
 * the renderer), so entries are pruned by age rather than on first sight —
 * deleting on the first observation would make the re-entry read as foreign
 * and supersede the workflow it belongs to.
 */
const questionsPromptReqIds = new Map<string, number>()
const QUESTIONS_REQ_ID_TTL_MS = 5 * 60_000

function pruneQuestionsReqIds(): void {
  const cutoff = Date.now() - QUESTIONS_REQ_ID_TTL_MS
  for (const [reqId, at] of questionsPromptReqIds) {
    if (at < cutoff) questionsPromptReqIds.delete(reqId)
  }
}

/** True when the given prompt reqId was a questions resume prompt. */
export function isQuestionsResumePrompt(reqId: string): boolean {
  return questionsPromptReqIds.has(reqId)
}

/**
 * Prompt-dispatch observer, called from the prompt pipeline for EVERY
 * accepted prompt. Resolves the parked-question lifecycle: our own resume
 * prompt completes the submitting workflow; any other prompt supersedes the
 * session's parked questions.
 */
export function notifyQuestionsPromptDispatched(tabId: string, reqId: string): void {
  const coord = coordinator
  if (!coord) return
  pruneQuestionsReqIds()
  coord.handlePromptDispatched(tabId, questionsPromptReqIds.has(reqId))
}

/** Tab id from an engine session key (`tabId` or `tabId:instanceId`). */
function tabIdFromSessionKey(sessionKey: string): string {
  const sep = sessionKey.indexOf(':')
  return sep === -1 ? sessionKey : sessionKey.slice(0, sep)
}

/**
 * Fan one accepted state out to every surface. The coordinator already
 * persisted; this is transport only.
 */
function fanout(snapshot: QuestionsStateSnapshot, changed: QuestionsWorkflowState | undefined): void {
  broadcast(IPC.QUESTIONS_STATE, snapshot)
  if (changed && state.remoteTransport) {
    state.remoteTransport.send({
      type: 'desktop_questions_state',
      tabId: tabIdFromSessionKey(changed.sessionKey),
      state: snapshot,
    })
  }
}

/** APNs doorbell for a NEW request — always with { tabId } metadata. */
function notify(workflow: QuestionsWorkflowState): void {
  if (!state.remoteTransport) return
  const tabId = tabIdFromSessionKey(workflow.sessionKey)
  state.remoteTransport.send(
    {
      type: 'desktop_questions_state',
      tabId,
      state: coordinator?.snapshot() ?? { workflows: [] },
    },
    true,
    {
      title: 'Ion needs your attention',
      body: `Questions waiting: ${workflow.request.title}`,
      tabId,
    },
  )
}

/**
 * The prompt sink the submitter dispatches through. Registered at startup by
 * prompt-pipeline (registerQuestionsPromptSink) rather than imported here.
 *
 * This is a REGISTRATION seam, not a convenience: questions-wiring and
 * prompt-pipeline import each other (the pipeline needs the dispatch
 * observer, the submitter needs the pipeline), and a static import cycle
 * would be resolved at bundle time in whichever order esbuild picks. The
 * previous attempt used a lazy `require('../prompt-pipeline')`, which
 * resolves fine from source but THROWS in the packaged app — the bundled
 * main process has no such module path, so every submit-bearing action
 * failed with "Cannot find module '../prompt-pipeline'". A registered
 * function has no module resolution at all, so it behaves identically in
 * dev and in app.asar.
 */
type QuestionsPromptSink = (prompt: {
  tabId: string
  text: string
  reqId: string
  source: 'desktop' | 'remote'
  hasExtensions: boolean
  instanceId?: string | null
  attachments?: Array<{ type: 'image' | 'file'; name: string; path: string }>
  injectionKind?: string
}) => Promise<void>

let promptSink: QuestionsPromptSink | null = null

/** Register the prompt dispatcher. Called once at startup by prompt-pipeline. */
export function registerQuestionsPromptSink(sink: QuestionsPromptSink): void {
  promptSink = sink
  log('questions prompt sink registered')
}

/**
 * Submitter: turn the workflow's accepted answers into a resume prompt and
 * dispatch it through the unified prompt pipeline. Returns true when the
 * dispatch was handed off. The parked session is idle, so this is an
 * ordinary prompt accept — the engine clears the retained denial and the
 * conversation resumes with the answers.
 *
 * source:'remote' is deliberate: that branch bounces once through the
 * renderer so the unified submit() inserts the optimistic user bubble and
 * builds full RunOptions (model, extensions, permission mode) from the
 * renderer store — the same round-trip every iOS prompt takes. A
 * main-originated prompt cannot build RunOptions itself.
 */
function submit(workflow: QuestionsWorkflowState, requestMore: boolean): boolean {
  const sink = promptSink
  if (!sink) {
    warn('questions submit failed: no prompt sink registered', { workflow_id: workflow.workflowId })
    return false
  }
  const built = buildQuestionsResumePrompt(workflow, requestMore)
  const reqId = `questions-${workflow.workflowId.slice(0, 8)}-${Date.now()}`
  questionsPromptReqIds.set(reqId, Date.now())
  // The workflow's sessionKey is the ENGINE session key: `tabId` for plain
  // conversations, `tabId:instanceId` for extension-hosted ones. Split it
  // back into pipeline routing facts.
  const sep = workflow.sessionKey.indexOf(':')
  const tabId = sep === -1 ? workflow.sessionKey : workflow.sessionKey.slice(0, sep)
  const instanceId = sep === -1 ? undefined : workflow.sessionKey.slice(sep + 1)
  void sink({
    tabId,
    text: built.text,
    reqId,
    source: 'remote',
    hasExtensions: instanceId !== undefined,
    instanceId,
    attachments: built.attachments.length > 0 ? built.attachments : undefined,
    // The operator answered in the wizard, which already shows their
    // answers. This prompt is the engine-facing rendering of that
    // submission, so it is classified machine-authored and never echoed
    // into the transcript as a user bubble — the same treatment agent and
    // background-task callbacks get.
    injectionKind: 'structured_answer',
  }).catch((err: unknown) => {
    warn('questions resume prompt pipeline error', { workflow_id: workflow.workflowId, error: String(err) })
  })
  log('questions resume prompt dispatched', {
    workflow_id: workflow.workflowId, tab_id: tabId.slice(0, 8),
    request_more: requestMore, attachment_count: built.attachments.length,
  })
  return true
}

/** Wire everything. Idempotent per process (startup calls it once). */
export function wireQuestions(bridge: QuestionsWiringBridge): QuestionsCoordinator {
  const coord = new QuestionsCoordinator(submit, fanout, notify)
  coordinator = coord
  coord.restore()

  // Engine → coordinator: parked AskUserQuestions denials ride
  // engine_status (idle snapshots re-publish retained denials on every
  // heartbeat — the same channel AskUserQuestion / ExitPlanMode cards use),
  // so a desktop that reconnects or restarts re-learns the parked question
  // from the first heartbeat. The same idle snapshot doubles as the
  // reconcile authority: workflows whose denial the engine no longer
  // retains (superseded by a prompt from another client while this desktop
  // was closed) retire. A RUNNING→idle transition additionally fails any
  // awaiting_next workflow whose continuation call never arrived — judged
  // only on a real transition, never on an idle heartbeat, so it cannot
  // race the resume dispatch.
  const lastEngineState = new Map<string, string>()
  bridge.on('event', (key: string, event: EngineEvent) => {
    if (event.type !== 'engine_status' || !event.fields) return
    const denials = event.fields.permissionDenials
    const retained = new Set<string>()
    if (Array.isArray(denials)) {
      for (const denial of denials) {
        if (denial?.toolName === 'AskUserQuestions' && denial.toolUseId) {
          retained.add(denial.toolUseId)
          coord.handleParkedQuestion(key, denial.toolUseId, (denial.toolInput ?? {}) as Record<string, unknown>)
        }
      }
    }
    const engineState = typeof event.fields.state === 'string' ? event.fields.state : ''
    const prevState = lastEngineState.get(key)
    if (engineState) lastEngineState.set(key, engineState)
    if (engineState === 'idle') {
      // sawDenialEvidence: this snapshot actually carried AskUserQuestions
      // denials. An empty list is ambiguous — it means either "the question is
      // gone" or "this session was re-registered on reconnect and has not
      // re-published its retained state yet" — and treating the empty case as
      // authoritative destroyed live workflows on every restart.
      coord.handleIdleDenialsSnapshot(key, retained, retained.size > 0)
      if (prevState === 'running') coord.handleRunIdle(key)
    }
  })

  // Renderer IPC (validated: shape-checked before the coordinator sees it).
  ipcMain.handle(IPC.QUESTIONS_GET_STATE, () => coord.snapshot())
  ipcMain.handle(IPC.QUESTIONS_PATCH, (_event, patch: unknown) => {
    const err = validatePatchShape(patch)
    if (err) {
      warn('renderer patch rejected by validation', { error: err })
      return { actionId: '', accepted: false, error: err }
    }
    return coord.applyPatch(patch as QuestionsPatch)
  })
  ipcMain.handle(IPC.QUESTIONS_ACTION, (_event, action: unknown) => {
    const err = validateActionShape(action)
    if (err) {
      warn('renderer action rejected by validation', { error: err })
      return { actionId: '', accepted: false, error: err }
    }
    return coord.applyAction(action as QuestionsAction)
  })
  // Transcript-derived rehydration. The renderer hands over the mapped rows
  // of a conversation it just restored; a parked question found there opens a
  // workflow even when the ~/.ion/questions cache is empty. This is what makes
  // a Guided Questions round survive a restart, a reinstall, or a wiped cache
  // — the same durability the single-question card gets from the transcript.
  ipcMain.handle(IPC.QUESTIONS_REHYDRATE, (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return false
    const { tabId, rows } = payload as { tabId?: unknown; rows?: unknown }
    if (typeof tabId !== 'string' || !tabId) {
      warn('rehydrate rejected: tabId is required')
      return false
    }
    if (!Array.isArray(rows)) {
      warn('rehydrate rejected: rows must be an array', { tab_id: tabId.slice(0, 8) })
      return false
    }
    return coord.rehydrateFromRows(tabId, rows as TranscriptRow[])
  })

  // Native image picker for per-question answer attachments. Overlay glass
  // must hide while the native dialog is up (same pattern as
  // SELECT_DIRECTORY in ipc/file-dialog.ts).
  ipcMain.handle(IPC.QUESTIONS_PICK_ATTACHMENTS, async (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const isOverlay = sender != null && sender === state.mainWindow
    if (isOverlay) state.mainWindow!.hide()
    const options = {
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] }],
    }
    const result = process.platform === 'darwin' || !sender
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(sender, options)
    if (isOverlay) showWindow('dialog-return')
    if (result.canceled) return []
    log('questions attachment picker selected', { count: result.filePaths.length })
    return result.filePaths.map((p) => ({ path: p, name: basename(p) }))
  })

  log('questions wiring complete')
  return coord
}

/**
 * Remote (iOS) command intake. Called from the remote command router. The
 * result state reaches the device through the ordinary fan-out; a stale
 * revision additionally gets the canonical state as a targeted send via the
 * fan-out's lastActionResult.
 */
export function handleQuestionsRemoteCommand(cmd: { type: string; tabId?: string; patch?: unknown; action?: unknown }): boolean {
  const coord = coordinator
  if (!coord) return false
  switch (cmd.type) {
    case 'desktop_questions_patch': {
      const err = validatePatchShape(cmd.patch)
      if (err) {
        warn('remote patch rejected by validation', { error: err })
        return true
      }
      coord.applyPatch(cmd.patch as QuestionsPatch)
      return true
    }
    case 'desktop_questions_action': {
      const err = validateActionShape(cmd.action)
      if (err) {
        warn('remote action rejected by validation', { error: err })
        return true
      }
      coord.applyAction(cmd.action as QuestionsAction)
      return true
    }
    case 'desktop_questions_refresh': {
      if (typeof cmd.tabId === 'string' && state.remoteTransport) {
        state.remoteTransport.send({
          type: 'desktop_questions_state',
          tabId: cmd.tabId,
          state: coord.snapshot(),
        })
      }
      return true
    }
    default:
      return false
  }
}

// ── Shape validation (transport payloads are untrusted) ─────────────────────

const ACTION_KINDS = new Set(['enter_review', 'edit_question', 'request_more', 'final_confirm', 'cancel'])

function validateMutationBase(v: Record<string, unknown>): string | null {
  if (typeof v.workflowId !== 'string' || !v.workflowId) return 'workflowId is required'
  if (typeof v.requestId !== 'string') return 'requestId is required'
  if (typeof v.expectedRevision !== 'number') return 'expectedRevision is required'
  if (typeof v.actionId !== 'string' || !v.actionId) return 'actionId is required'
  return null
}

function validateAnswersShape(answers: unknown): string | null {
  if (!Array.isArray(answers)) return 'answers must be an array'
  for (const a of answers) {
    if (typeof a !== 'object' || a === null) return 'answer must be an object'
    const ans = a as Record<string, unknown>
    if (typeof ans.questionId !== 'string') return 'answer.questionId is required'
    if (!Array.isArray(ans.selectedOptionIds) || ans.selectedOptionIds.some((id) => typeof id !== 'string')) {
      return 'answer.selectedOptionIds must be a string array'
    }
    if (ans.customText !== undefined && typeof ans.customText !== 'string') return 'answer.customText must be a string'
    if (ans.skipped !== undefined && typeof ans.skipped !== 'boolean') return 'answer.skipped must be a boolean'
    if (ans.attachments !== undefined) {
      if (!Array.isArray(ans.attachments)) return 'answer.attachments must be an array'
      for (const att of ans.attachments) {
        if (typeof att !== 'object' || att === null) return 'attachment must be an object'
        const at = att as Record<string, unknown>
        if (typeof at.path !== 'string' || !at.path) return 'attachment.path is required'
        if (typeof at.name !== 'string') return 'attachment.name is required'
      }
    }
  }
  return null
}

function validatePatchShape(patch: unknown): string | null {
  if (typeof patch !== 'object' || patch === null) return 'patch must be an object'
  const p = patch as Record<string, unknown>
  const base = validateMutationBase(p)
  if (base) return base
  if (p.answers !== undefined) {
    const err = validateAnswersShape(p.answers)
    if (err) return err
  }
  if (p.comment !== undefined && typeof p.comment !== 'string') return 'comment must be a string'
  return null
}

function validateActionShape(action: unknown): string | null {
  if (typeof action !== 'object' || action === null) return 'action must be an object'
  const a = action as Record<string, unknown>
  const base = validateMutationBase(a)
  if (base) return base
  if (typeof a.kind !== 'string' || !ACTION_KINDS.has(a.kind)) return 'kind must be a valid action'
  if (a.questionId !== undefined && typeof a.questionId !== 'string') return 'questionId must be a string'
  if (a.answers !== undefined) {
    const err = validateAnswersShape(a.answers)
    if (err) return err
  }
  if (a.comment !== undefined && typeof a.comment !== 'string') return 'comment must be a string'
  return null
}
