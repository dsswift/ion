/**
 * Engine-status translation is isolated because reconnect attachment, durable
 * identity reconciliation, and terminal status synthesis are one state-machine
 * seam. Keeping it here prevents the event router from exceeding its cap.
 */
import type { EngineConfig, EngineEvent, NormalizedEvent } from '../shared/types'
import { log as _log, debug as _debug, trace as _trace, warn as _warn, error as _error } from './logger'
import { conversationExists } from './session-meta'
import { toolGateSessionConfig } from './tool-gate-responder'
import { requiresUserResponse } from './engine-control-plane-user-response'
import { idleOrdering } from './engine-control-plane-idle-ordering'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function trace(msg: string, fields?: Record<string, unknown>): void { _trace(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error(TAG, msg, fields) }

export { handleStatusEvent }

// Handles engine_status snapshots. Keeping this lifecycle-heavy handler apart
// from the event switch keeps both control-plane modules under the file cap.
function handleStatusEvent(
  ctx: EventEmitterContext,
  tabId: string,
  tab: TabEntry,
  event: Extract<EngineEvent, { type: 'engine_status' }>,
): void {
  if (!event.fields) return
  // Per-status (fires on every heartbeat tick across every session): logged at
  // DEBUG so the default INFO level filters it before serialization. State
  // transitions of note (first-bind, divergence resume) stay at INFO/WARN below.
  debug('engine_status', { tab_id: tabId, state: event.fields.state, session_id: event.fields.sessionId ?? 'none', cost_usd: event.fields.runCostUsd ?? 0 })
  void import('./automation/runtime')
    .then(({ getAutomationRuntime }) => getAutomationRuntime().triggerStatus(tabId, {
      state: event.fields.state ?? 'unknown',
      sessionId: event.fields.sessionId ?? '',
      completionReason: event.fields.completionReason ?? '',
      permissionDenials: event.fields.permissionDenials ?? [],
    }))
    .catch((err) => error('engine_status automation trigger failed', { tab_id: tabId, error: String(err) }))
  // Forward the full StatusFields snapshot to the renderer BEFORE the
  // state-binding branches below. The renderer's `status` arm replaces
  // inst.statusFields wholesale (snapshot semantics). This is unconditional —
  // every engine_status, all states — so the renderer's statusFields tracks
  // model/backend/cost/extensionName on running, idle, and cost-only heartbeat
  // ticks alike, not just on idle (the binding/task_complete path below drops
  // those fields). The emit is additive; the existing binding logic is unchanged.
  debug('engine_status: forwarding to renderer', { tab_id: tabId, state: event.fields.state, model: event.fields.model ?? 'none' })
  ctx.emit('event', tabId, { type: 'status', fields: event.fields } as NormalizedEvent)
  // Track the engine's run counter on EVERY status, whatever the state, so the
  // value submitPrompt records as its ordering baseline is the freshest reading
  // available. Absent (older engine) leaves the previous reading untouched
  // rather than nulling it — a single fieldless emission must not erase a
  // baseline a live dispatch is relying on.
  if (typeof event.fields.runEpoch === 'number') {
    tab.lastObservedRunEpoch = event.fields.runEpoch
  }
  if (event.fields.state === 'idle') {
    if (event.fields.sessionId) {
      if (!tab.conversationId) {
        // First-ever bind: adopt the engine's id (normal first-start path).
        //
        // This branch is now reached ONLY when the tab genuinely had no id from
        // any source. The two start sites both seed tab.conversationId before
        // the engine can emit this idle: ensureSession seeds it from the tracked
        // id (plain tabs), and the ENGINE_START IPC calls
        // sessionPlane.seedConversationId from config.sessionId (extension
        // tabs). So a restored tab that knows its real conversation arrives here
        // already-seeded and takes the matching-id branch below — it never
        // adopts a pre-minted empty id. Reaching this branch means a true
        // first-start (new tab, no persisted conversation), where adopting the
        // engine's freshly-minted id is correct.
        log('engine_status: first-bind adopting engine sessionId', { tab_id: tabId, session_id: event.fields.sessionId })
        tab.conversationId = event.fields.sessionId
        // True first-start (new tab, no persisted conversation) — a fresh mint,
        // not a resume. Leave resumedSavedConversation false (scenario C) so a
        // first-prompt slash command stays fresh and flips plan→auto.
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else if (tab.conversationId === event.fields.sessionId) {
        // Matching id: no-op (normal heartbeat tick or stable idle).
        ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
      } else {
        // Divergence: the engine has a different id than the one this tab
        // tracks. There are two distinct sub-cases, and conflating them is what
        // caused the morning data loss:
        //
        //   (a) The tracked id is a REAL conversation (file exists on disk).
        //       This is the post-restart pre-mint footgun (#230 B1): the engine
        //       pre-minted before the client asserted the real id. Drive a
        //       resume so the engine rebinds the key to the real conversation.
        //
        //   (b) The tracked id is a PHANTOM (no backing file). It was itself a
        //       pre-mint from a PRIOR restart that was never saved. Driving a
        //       resume to it is futile — the engine now (correctly) ignores a
        //       fileless sessionId and pre-mints AGAIN, so re-pinning the
        //       phantom just spins the cascade that orphaned the real history.
        //       Instead, adopt the engine's freshly-minted id as the tab's new
        //       identity and stop fighting. The real prior history (if any) is
        //       in the persisted scrollback; a future save under this real id
        //       makes it durable. (#230/#231)
        const trackedIsReal = conversationExists(tab.conversationId)
        if (!trackedIsReal) {
          warn(
            `engine_status: tabId=${tabId} tracked conversationId=${tab.conversationId} has NO backing file (phantom) — adopting engine sessionId=${event.fields.sessionId} instead of re-driving a futile resume (breaks the empty-conversation cascade)`,
          )
          tab.conversationId = event.fields.sessionId
          ctx.bridge.updateSessionConversationId(tabId, event.fields.sessionId)
        } else {
          // (a) Real tracked conversation — drive the resume.
          //
          // Carry the tab's REAL config into the resume (workingDirectory,
          // extensions, model) rather than empty placeholders: a bare config would
          // start a degraded session (wrong cwd, no extensions). The bridge holds
          // the last EngineConfig used for this key; we reuse it and override only
          // sessionId so the engine resumes the original conversation with the same
          // working session. Falls back to a minimal config only if the bridge has
          // no record (should not happen for a started session). (#231)
          const priorConfig = ctx.bridge.getSessionConfig(tabId)
          const resumeConfig: EngineConfig = priorConfig
            ? { ...priorConfig, sessionId: tab.conversationId, forceNewConversation: false }
            : { profileId: 'default', extensions: [], workingDirectory: '', sessionId: tab.conversationId, toolGate: toolGateSessionConfig() }
          warn(
            `engine_status: tabId=${tabId} engine sessionId=${event.fields.sessionId} diverges from tracked conversationId=${tab.conversationId} — driving resume to restore original conversation (dir=${resumeConfig.workingDirectory || 'none'} model=${resumeConfig.model ?? 'default'} extensions=${resumeConfig.extensions.length})`,
          )
          ctx.bridge.updateSessionConversationId(tabId, tab.conversationId)
          void ctx.bridge.startSession(tabId, resumeConfig)
        }
      }
    }

    const hasPendingWork = event.fields.hasPendingWork === true
      || (event.fields.backgroundAgents ?? 0) > 0
      || (event.fields.backgroundShells ?? 0) > 0
    if (hasPendingWork) {
      // The foreground run stopped, but the engine has exact live work or an
      // accepted delivery still pending. This is not a completion. A distinct
      // tab state prevents all terminal consumers from treating it as one.
      log('engine_status: waiting on pending work', {
        tab_id: tabId,
        background_agents: event.fields.backgroundAgents ?? 0,
        background_shells: event.fields.backgroundShells ?? 0,
        has_pending_work: event.fields.hasPendingWork === true,
      })
      ctx.setStatus(tabId, 'waiting')
      ctx.checkDrain()
      return
    }

    // Session-ready idle: the engine emits engine_status(starting) → (idle)
    // when a session is first established, BEFORE any prompt runs (see
    // engine/internal/session/start_session.go). On the profile-launch create
    // path the renderer set its tab to 'connecting' (createConversationTab)
    // while the control-plane TabEntry is still 'idle'; this ready idle is the
    // only signal that clears the renderer's 'connecting'. A never-run session
    // is identified by activeRequestId == null && startedAt === 0 (no prompt
    // has ever been dispatched on this tab). Forward an 'idle' status
    // transition to the renderer — directly, because _setStatus would no-op
    // (the control-plane TabEntry is already 'idle') — and do NOT synthesize a
    // task_complete (that would fabricate a completed run and trip
    // auto-move-to-done for a session that ran nothing).
    const isReadyIdle = tab.activeRequestId == null && tab.startedAt === 0
    // A session-ready idle must converge BOTH consumers of the state. When the
    // control plane is attaching, update its authoritative entry through the
    // status writer so a SIGUSR1 drain can release. An entry already at idle
    // needs only a renderer re-assert because applyStatus intentionally skips an
    // idle -> idle transition.
    if (
      (tab.status === 'idle' || tab.status === 'connecting' || tab.status === 'starting') &&
      isReadyIdle
    ) {
      if (tab.status === 'idle') {
        debug('engine_status: session-ready idle, re-asserting renderer state', { tab_id: tabId })
        ctx.emit('tab-status-change', tabId, 'idle', tab.status)
        ctx.checkDrain()
      } else {
        debug('engine_status: session-ready idle, settling control-plane state', { tab_id: tabId, from: tab.status })
        ctx.setStatus(tabId, 'idle')
      }
      return
    }

    // Compute whether THIS idle carries a proposal that needs a user
    // response (ExitPlanMode / AskUserQuestion) BEFORE the duplicate-skip
    // guard. A proposal-bearing idle is the first-and-only delivery of the
    // Plan Ready / question card trigger; it must never be silently dropped
    // as a "duplicate heartbeat". The guard below exists to suppress
    // cost-only heartbeat ticks and stale post-reset idles — NOT to drop the
    // first real proposal. (Bug #2: an auto-dispatched run that flips to plan
    // mid-run lands its ExitPlanMode denial on an idle that arrives while the
    // tab is already 'completed'/'idle' from a heartbeat, so the unconditional
    // skip dropped the only card trigger and the Plan Ready card never
    // rendered. Confirmed live in desktop.log: "skipping idle for idle tab
    // 60726597-…".)
    const idleNeedsUserResponse = event.fields.permissionDenials?.some(
      (d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
    )

    // 'connecting' is exempted from the proposal pass-through below and ALWAYS
    // skips: a prompt has been dispatched (activeRequestId/startedAt set by
    // submitPrompt) and the engine hasn't replied state='running' yet, OR a
    // stale idle from a session killed by resetTabSession during the Implement
    // flow is arriving after the new run started. In BOTH 'connecting' cases a
    // newer run supersedes; the engine clears its lastPermissionDenials on the
    // new prompt dispatch (prompt_dispatch.go), so a denial echoed on a
    // 'connecting' idle is stale and must not resurrect a just-dismissed card.
    if (tab.status === 'connecting') {
      trace('engine_status: skipping idle, new run in flight', { tab_id: tabId })
      return
    }

    // ORDERING GUARD — the companion to the 'connecting' skip above.
    //
    // That skip catches a stale idle only while the tab still reads
    // 'connecting'. It does not fire on the ordinary send path, because
    // submitPrompt moves the tab to 'running' the moment ensureSession
    // succeeds — and the reconcile handshake that start_session fired arrives
    // AFTER that, while the engine still has no run. The engine honestly
    // reports idle, this handler read it as a completion, and the conversation
    // was marked done seconds before its run began.
    //
    // Decide on ordering instead of on local status: an idle snapshot built at
    // or before the epoch this tab recorded when it dispatched describes the
    // state BEFORE the prompt, and is never its completion.
    const ordering = idleOrdering(tab, event.fields.runEpoch)
    if (ordering.stale) {
      log('engine_status: skipping idle, snapshot predates the in-flight prompt', {
        tab_id: tabId,
        status: tab.status,
        reason: ordering.reason,
        snapshot_run_epoch: event.fields.runEpoch ?? -1,
        dispatch_run_epoch: tab.dispatchRunEpoch ?? -1,
        request_id: tab.activeRequestId ?? '',
      })
      return
    }
    if (tab.activeRequestId != null) {
      // Log the accept side too, so a completion that DID pass the guard is as
      // reconstructable from the log as one that was refused.
      debug('engine_status: idle accepted as run boundary', {
        tab_id: tabId,
        reason: ordering.reason,
        snapshot_run_epoch: event.fields.runEpoch ?? -1,
        dispatch_run_epoch: tab.dispatchRunEpoch ?? -1,
      })
    }
    // A session recreated by the engine restarts its counter at zero. Rebase
    // the baseline onto the new session's numbering so the next comparison is
    // made in the same sequence, rather than against a value from a session
    // that no longer exists.
    if (ordering.reason === 'session_rebased') {
      log('engine_status: run epoch decreased, rebasing onto the new session', {
        tab_id: tabId,
        snapshot_run_epoch: event.fields.runEpoch ?? -1,
        prior_dispatch_run_epoch: tab.dispatchRunEpoch ?? -1,
      })
      tab.dispatchRunEpoch = event.fields.runEpoch ?? null
    }

    if (
      (tab.status === 'completed' || tab.status === 'idle') &&
      !idleNeedsUserResponse
    ) {
      // 'completed' / 'idle' with NO proposal denial: already synthesized
      // task_complete for this idle transition — skip duplicates from
      // cost-only heartbeat ticks. The engine re-publishes retained denials
      // on every heartbeat (manager_heartbeat.go), so without this skip a
      // cost-only tick would synthesize a redundant task_complete.
      trace('engine_status: skipping idle, no denials', { tab_id: tabId, status: tab.status })
      return
    }

    if ((tab.status === 'completed' || tab.status === 'idle') && idleNeedsUserResponse) {
      // This idle carries a proposal denial (ExitPlanMode / AskUserQuestion)
      // and the tab is in a settled terminal state (NOT 'connecting', so no
      // newer run is in flight). It is the genuine card trigger for an
      // auto-dispatched mid-run plan flip — but the engine RE-PUBLISHES the
      // same retained denial on every heartbeat (manager_heartbeat.go), so we
      // must surface it ONCE per distinct proposal. Dedup on a stable
      // signature of the proposal so a heartbeat echo does not re-synthesize a
      // task_complete (which would resurrect a card the user already
      // dismissed). A genuinely new proposal (different tool / plan path)
      // produces a different signature and re-fires.
      const proposalSig = (event.fields.permissionDenials || [])
        .filter((d: any) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion')
        .map((d: any) => `${d.toolName}:${d.toolInput?.planFilePath ?? d.toolUseID ?? ''}`)
        .sort()
        .join('|')
      if (tab.lastSurfacedProposalSig === proposalSig) {
        log('engine_status: skipping proposal idle, already surfaced', { tab_id: tabId, status: tab.status, proposal_sig: proposalSig })
        return
      }
      tab.lastSurfacedProposalSig = proposalSig
      // Log the first delivery so the decision is reconstructable from
      // desktop.log (logging policy: log both branches).
      const toolNames = (event.fields.permissionDenials || [])
        .map((d: any) => d.toolName)
        .join(',')
      log('engine_status: forwarding proposal idle', { tab_id: tabId, status: tab.status, tool_names: toolNames, proposal_sig: proposalSig })
    }

    const durationMs = tab.startedAt ? Date.now() - tab.startedAt : 0
    void import('./automation/runtime')
      .then(({ getAutomationRuntime }) => getAutomationRuntime().triggerCompletion(tabId, {
        sessionId: tab.conversationId || event.fields.sessionId || '',
        reason: event.fields.completionReason ?? '',
        runCostUsd: event.fields.runCostUsd ?? 0,
        numTurns: event.fields.numTurns ?? 1,
        endedWithQuestion: idleNeedsUserResponse === true,
      }, tab.automationCausation))
      .catch((err) => error('conversation completion automation trigger failed', { tab_id: tabId, error: String(err) }))

    ctx.emit('event', tabId, {
      type: 'task_complete',
      result: '',
      reason: event.fields.completionReason,
      costUsd: event.fields.runCostUsd || 0,
      durationMs,
      numTurns: event.fields.numTurns ?? 1,
      conversationTurns: event.fields.conversationTurns,
      usage: { input_tokens: 0, output_tokens: 0 },
      sessionId: tab.conversationId || '',
      permissionDenials: event.fields.permissionDenials,
    } as NormalizedEvent)

    tab.activeRequestId = null
    tab.automationCausation = undefined
    // Preserve 'completed' status whenever the engine reported denials that
    // require a user response. Otherwise a subsequent engine_status state=idle
    // (e.g. a cost-only update fired ~1ms later) will fail the guard at the
    // top of this branch (`tab.status === 'completed'`), synthesize a second
    // task_complete with empty permissionDenials, and clobber the renderer's
    // permissionDenied state — making the AskUserQuestion / ExitPlanMode card
    // never appear. ExitPlanMode was already handled; AskUserQuestion was the
    // missed case.
    const needsUserResponse = requiresUserResponse(event.fields)
    log('engine_status: task_complete synthesized', { tab_id: tabId, denials: event.fields.permissionDenials?.length ?? 0, needs_user_response: needsUserResponse })
    ctx.setStatus(tabId, needsUserResponse ? 'completed' : 'idle')
    ctx.checkDrain()
  } else if (event.fields.state === 'starting') {
    log('engine_status: session attaching', { tab_id: tabId })
    ctx.setStatus(tabId, 'starting')
    ctx.checkDrain()
  } else if (event.fields.state === 'running') {
    if (tab.status !== 'running') {
      ctx.emit('event', tabId, {
        type: 'session_init',
        sessionId: tab.conversationId || '',
        tools: [],
        model: event.fields.model || '',
        mcpServers: [],
        skills: [],
        version: '',
        isWarmup: false,
      } as NormalizedEvent)
    }
    // A real run started: clear the surfaced-proposal dedup so the NEXT
    // proposal produced by this new work re-surfaces even if it happens to
    // carry an identical signature to the prior one (e.g. the model re-enters
    // plan mode and proposes the same plan file again).
    tab.lastSurfacedProposalSig = null
    ctx.setStatus(tabId, 'running')
  }
}
