/**
 * Harness-supplied prose constants for the desktop's prompt pipeline.
 *
 * Per ADR-004 (Move EnterPlanMode prose to harness), the engine ships only a
 * one-line policy-neutral fallback for tool descriptions and defers the actual
 * prose to the harness. This file is that prose for the desktop harness: it
 * owns the text the model sees when plan-mode tooling is in play.
 *
 * Third-party harnesses write their own — TUIs may prefer minimal framing;
 * domain-specific harnesses may want "test plan" / "RFC" language. The
 * constants are exported so future override paths (e.g. a power-user
 * `desktop.enterPlanModeDescription` key in ~/.ion/settings.json per ADR-004's
 * Future considerations) can default to them.
 *
 * Splitting rationale
 * ───────────────────
 * prompt-pipeline.ts owns the decision tree. The tree is a single unit whose
 * ordering invariants must be readable end-to-end without jumping files.
 * These prose constants are policy-data, not control flow; they belong in a
 * dedicated file so the decision tree file stays focused. See the file-size
 * posture section in prompt-pipeline.ts for the full three-file cluster
 * description.
 */

/**
 * Harness-supplied description prose for the engine's EnterPlanMode
 * sentinel tool.
 *
 * Per ADR-004 (Move EnterPlanMode prose to harness), the engine ships
 * only a one-line policy-neutral fallback for the tool description and
 * defers the actual prose — when to enter plan mode, what the rules are
 * once enabled, when NOT to enter — to the harness. This module is the
 * desktop's harness, and ENTER_PLAN_MODE_DESCRIPTION is the canonical
 * Ion-on-desktop framing the model sees on every auto-mode prompt the
 * desktop dispatches.
 *
 * Third-party harnesses are NOT expected to copy this constant — they
 * write their own (TUIs may prefer minimal framing; domain-specific
 * harnesses may want "test plan" / "design doc" / "RFC" language). The
 * constant is exported so future override paths (e.g. a power-user
 * settings.json `desktop.enterPlanModeDescription` key per ADR-004's
 * Future considerations) can default to it.
 *
 * The text was lifted verbatim from the engine's prior in-tree default
 * (commit 89084038 / engine/internal/tools/enter_plan_mode.go) so the
 * desktop's user-facing behavior is unchanged from before ADR-004. If
 * you edit this text, the edit ships to every desktop install on the
 * next release — be intentional.
 */
export const ENTER_PLAN_MODE_DESCRIPTION = `Switch the current session into plan mode.

Call this tool when the task at hand warrants careful planning before execution:
- The user has asked for a plan ("make a plan for...", "plan how to...", "before you do anything, plan...")
- The request involves multiple files, architectural changes, or non-trivial scope
- You need to confirm an approach with the user before making any changes
- A previous workflow step has completed and a follow-up plan is needed

Once called, the session switches to plan mode where:
- Only read-only tools (Read, Grep, Glob, WebFetch, WebSearch) are available
- If the user has configured allowed Bash commands, Bash is also available but restricted to those command prefixes only
- You may write exclusively to the plan file to build your plan
- Each turn must end with AskUserQuestion (for clarification) or ExitPlanMode (plan complete)
- All code modifications are blocked until the user reviews and approves the plan

Do NOT call this tool if:
- You are already in plan mode.
- The user's request is simple enough to execute directly without planning.
- The user has just asked you to implement an existing plan — proceed directly with the work, do not re-plan.`

/**
 * Desktop sparse plan-mode reminder text, injected by the engine every
 * planModeReminderInterval turns during plan-mode runs.
 *
 * Per Fix 3 / Fix 4 of the plan-mode end-of-turn discipline fix (see
 * docs/architecture/adr/005-plan-mode-prose-symmetry.md), the engine
 * exposes RunOptions.PlanModeSparseReminder as a parallel override to
 * RunOptions.PlanModePrompt. This constant is the desktop's reference
 * value, forwarded on every plan-mode prompt dispatch.
 *
 * The text is intentionally short (it appears every N turns) and includes
 * the Forbidden Prose Patterns callout that the full prompt also carries.
 * Power users can override via desktop.planModeSparseReminder in
 * ~/.ion/settings.json; the desktop reads that key at session start and
 * passes it here in place of this constant.
 *
 * Third-party harnesses supply their own or set RunOptions.PlanModeSparseReminder
 * directly; this constant is desktop-harness-specific, not a universal default.
 */
export const PLAN_MODE_SPARSE_REMINDER =
  'Plan mode still active (see full instructions from earlier in conversation). ' +
  'Read-only except plan file. ' +
  'End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). ' +
  'Never use AskUserQuestion to ask for plan approval -- that is what ExitPlanMode is for. ' +
  'If the plan is written and complete, call ExitPlanMode — do not delay with another question. The user has no visibility into plan content until ExitPlanMode is called. ' +
  'Forbidden as prose: "Is this plan okay?", "Should I proceed?", "Let me know if you\'d like changes", ' +
  '"How does this plan look?" -- these must use ExitPlanMode or AskUserQuestion.'
