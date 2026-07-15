// Plan-mode event handlers extracted from event-slice.ts (Fix 1: keep the
// reducer under the 600-line cap). These are the `engine_plan_mode_changed`
// and `engine_plan_proposal` arms of the single normalized-event reducer,
// lifted out verbatim. They mutate the shared reducer context (messages +
// the per-instance patch) through a passed-by-reference context object,
// exactly as the inline switch arms did. No behavior change.
import type { Message } from '../../../shared/types'
import type { ConversationInstance } from '../../../shared/types-engine'
import { nextMsgId } from '../session-store-helpers'
import { formatPlanCreatedDivider, formatPlanUpdatedDivider } from '../../../shared/clear-divider'
import { rInfo, rWarn } from '../../rendererLogger'

/**
 * Mutable context shared with the parent reducer for one plan-mode event.
 * The parent seeds it from its locals; the handler mutates `messages`
 * (reassigned on append), `instPatch`, and `instTouched` in place; the parent
 * reads them back after the call.
 */
export interface PlanModeCtx {
  tabId: string
  /** The active instance snapshot at reducer entry (read-only here). */
  inst0: { planFilePath?: string | null; permissionMode?: 'auto' | 'plan'; permissionDenied?: ConversationInstance['permissionDenied'] } | null
  /** Working copy of the active instance's messages (reassigned on append). */
  messages: Message[]
  /** Per-conversation patch object the parent commits onto the instance. */
  instPatch: Partial<ConversationInstance>
  /** Set true when instPatch was mutated (parent reads this back). */
  instTouched: boolean
}

/**
 * Handle the plan-mode event arms. Returns true when the event type was one
 * of these arms, false otherwise. Behavior is identical to the former inline
 * cases.
 */
export function handlePlanModeEvent(ctx: PlanModeCtx, event: any): boolean {
  switch (event.type) {
    case 'engine_plan_mode_changed':
      // Only Enabled:true is authoritative — model-initiated
      // EnterPlanMode confirms the session has entered plan mode.
      // Enabled:false from a model-initiated ExitPlanMode is a
      // *proposal* awaiting user approval, so we do NOT flip the
      // dropdown to auto here. The user-approval chokepoint in
      // implementPlan (implement-slice.ts) is responsible for
      // the mode flip back to 'auto'. The engine no longer emits
      // false for the ExitPlanMode case, but this branch still
      // guards against any future emitter.
      if (event.planModeEnabled) {
        // WI-001: Write plan mode to the active INSTANCE for all
        // conversation types (plain and extension-hosted). The parent
        // tab.permissionMode is no longer written here — the instance
        // is the authoritative location post-collapse. effectivePermissionMode()
        // reads the instance first, falling back to the parent, so
        // existing consumers continue to work. The sticky-parent bug
        // (where tab.permissionMode stayed 'plan' and blocked the
        // done-group move) is eliminated by never writing the parent.
        ctx.instPatch.permissionMode = 'plan'
        ctx.instTouched = true
        // NOTE: this arm no longer inserts a "Plan created" divider. Plan-mode
        // ENTRY happens before the model has written anything — the plan file
        // does not yet exist on disk, so a divider here would be mispositioned
        // (before any narrative) and its link would not resolve. The divider is
        // now driven by engine_plan_file_written, which fires the moment a
        // Write/Edit actually lands on the plan file (see that arm below).
      }
      // Only update planFilePath when entering plan mode.
      // When planModeEnabled=false this is a proposal event (ExitPlanMode
      // awaiting user approval); planFilePath stays unchanged.
      if (event.planModeEnabled && event.planFilePath) {
        ctx.instPatch.planFilePath = event.planFilePath
        ctx.instTouched = true
      }
      return true

    case 'engine_plan_file_written': {
      // The engine confirmed a Write/Edit landed on the canonical plan file.
      // This is the accurate point to insert the plan-lifecycle divider: the
      // file now exists with content, so the marker is correctly positioned in
      // the transcript (right after the write, following the model's narrative)
      // and the slug link resolves. The engine carries the created-vs-updated
      // discriminator (planWriteOperation) because only it can observe the
      // file's prior state; we trust it rather than re-deriving from scrollback.
      const planFilePath = event.planFilePath
      const op = event.planWriteOperation === 'updated' ? 'updated' : 'created'
      const dividerContent =
        op === 'updated'
          ? formatPlanUpdatedDivider(new Date(), event.planSlug)
          : formatPlanCreatedDivider(new Date(), event.planSlug)
      ctx.messages = [
        ...ctx.messages,
        {
          id: nextMsgId(),
          role: 'system' as const,
          content: dividerContent,
          timestamp: Date.now(),
          planFilePath,
        },
      ]
      // Keep the instance's planFilePath in sync so downstream consumers
      // (attachments panel, implement handler) have the path even if the
      // entry event was lost.
      if (planFilePath && ctx.inst0?.planFilePath !== planFilePath) {
        ctx.instPatch.planFilePath = planFilePath
        ctx.instTouched = true
      }
      return true
    }

    case 'engine_plan_proposal': {
      // Workflow event from the engine: the model has proposed a
      // plan-mode transition (currently only kind="exit"). This is
      // NOT a state change — the engine has NOT flipped plan mode
      // off. This event lets the renderer learn about the proposal
      // *as soon as the model calls the tool*, before task_complete
      // arrives. We record the proposed plan path on the instance so
      // downstream UI (e.g. the implement button) has it without
      // having to scrape it from permissionDenied entries. See
      // docs/architecture/adr/003-state-events-vs-workflow-events.md.
      //
      // Bug #2 fix: this event is ALSO a sufficient, first-class card
      // trigger. Previously the Plan Ready card depended solely on
      // task_complete.permissionDenials, and a race in the control plane
      // (the idle-skip guard dropping the proposal-bearing idle) could
      // suppress that denial so the card never rendered. We now synthesize
      // the ExitPlanMode permissionDenied directly from the proposal when
      // none is already present. This is idempotent with the task_complete
      // path: if task_complete later carries the same ExitPlanMode denial,
      // it replaces this synthesized one (same tool, same plan path) → one
      // card, not two. We only synthesize for kind="exit"; other kinds carry
      // no approval card today.
      const proposal = event
      const kind = proposal.planProposalKind ?? proposal.kind
      const path = proposal.planFilePath
      rInfo('event.plan-mode', 'plan proposal received', { tab_id: ctx.tabId.slice(0, 8), kind, path: path ?? '', plan_slug: proposal.planSlug ?? '' })
      if (path && ctx.inst0?.planFilePath !== path) {
        ctx.instPatch.planFilePath = path
        ctx.instTouched = true
      }
      // Synthesize the card trigger when the proposal is an exit and no
      // permissionDenied is already set (task_complete may have lost the
      // race, or not arrived yet). 'permissionDenied' in instPatch covers
      // the case where an earlier arm in THIS reducer pass already set it.
      const alreadyDenied =
        ('permissionDenied' in ctx.instPatch
          ? ctx.instPatch.permissionDenied
          : ctx.inst0?.permissionDenied) != null
      if (kind === 'exit' && !alreadyDenied) {
        ctx.instPatch.permissionDenied = {
          tools: [
            {
              toolName: 'ExitPlanMode',
              // No engine toolUseId on the proposal event; synthesize a
              // stable id so the card has a key. The Implement handler reads
              // planFilePath from toolInput / the instance, not this id.
              toolUseId: `plan-proposal-${ctx.tabId}`,
              toolInput: path ? { planFilePath: path } : {},
            },
          ],
        }
        ctx.instTouched = true
        rInfo('event.plan-mode', 'synthesized ExitPlanMode permission denied from proposal', { tab_id: ctx.tabId.slice(0, 8), path: path ?? '' })
      }
      // Layer 2 (regression DETECTOR): a kind="exit" proposal is definitive
      // proof the session was in plan mode awaiting approval. If this arm
      // runs with a non-'plan' instance, it means the instance permissionMode
      // was corrupted upstream (e.g. something prematurely flipped it to
      // 'auto'). This warning is the detector that catches that upstream
      // corruption. We do NOT auto-correct here — silently mutating
      // permissionMode would mask the defect that caused the corruption.
      // The instance stays exactly as it is; the warning surfaces the
      // upstream bug so it can be found and fixed at its root.
      // Skip when already 'plan' (the entry event delivered normally).
      const currentMode =
        ('permissionMode' in ctx.instPatch ? ctx.instPatch.permissionMode : ctx.inst0?.permissionMode) ?? 'auto'
      if (kind === 'exit' && currentMode !== 'plan') {
        rWarn('event.plan-mode', 'exit proposal arrived on non-plan instance — NOT auto-correcting; upstream mode corruption detected', { tab_id: ctx.tabId.slice(0, 8), mode: currentMode })
      }
      return true
    }
  }
  return false
}
