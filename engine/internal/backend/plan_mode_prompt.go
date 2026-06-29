package backend

import (
	"fmt"
	"os"
	"strings"
)

// defaultPlanModeTools is the read-only tool set allowed during plan mode.
// Extensions and harness can override via HookPlanModePrompt or set_plan_mode command.
var defaultPlanModeTools = []string{"Read", "Grep", "Glob", "Agent", "WebFetch", "WebSearch"}

// planModeReminderInterval is the number of turns between sparse plan-mode
// reminder injections. The first reminder fires on turn 2 (first post-entry
// turn); subsequent reminders fire only when at least this many turns have
// elapsed since the last injection. Matches Claude Code's
// TURNS_BETWEEN_ATTACHMENTS=5 design (src/utils/attachments.ts).
const planModeReminderInterval = 5

// planModeFirstTurnReminderThreshold is the conversation message count above
// which the sparse reminder fires even on turn 1 of a run. Fresh plan-mode
// entry (small message count) already has the full prompt in context — no
// double-injection needed. But mature single-turn rounds (many messages) are
// exactly the case where the model drifts: the full prompt is ~220+ messages
// back, and turn > 1 never fires because each "what's next?" is its own run.
// Tuned at 8 so the very first turn of a brand-new plan-mode session is
// silent, while any session that has had a back-and-forth gets the reminder.
const planModeFirstTurnReminderThreshold = 8

// shouldInjectPlanModeReminder is the throttle decision for the sparse
// reminder. Returns true on the first post-entry turn (lastReminderTurn==0)
// or when at least planModeReminderInterval turns have elapsed since the
// previous injection. Pulled out as a free function for direct unit testing
// without spinning up a full ApiBackend run.
func shouldInjectPlanModeReminder(turn, lastReminderTurn int) bool {
	if turn < 2 {
		return false
	}
	return lastReminderTurn == 0 || (turn-lastReminderTurn) >= planModeReminderInterval
}

// shouldInjectPlanModeReminderForRun is the extended gate that replaces the
// simple `turn > 1` check in the runloop. It folds in the "mature session
// turn-1" branch so single-turn rounds in long-running plan-mode conversations
// also receive the reminder.
//
// Gate logic:
//   - Turn 1 and conversation is small (≤ threshold): skip — the full prompt
//     was just injected at plan-mode entry, double-reminding is noise.
//   - Turn 1 and conversation is large (> threshold): inject — the full prompt
//     is far back in context; this is the mid-plan follow-up case that was
//     previously broken.
//   - Turn 2+: delegate to the existing shouldInjectPlanModeReminder throttle
//     (first post-entry turn fires unconditionally; subsequent turns respect
//     planModeReminderInterval).
func shouldInjectPlanModeReminderForRun(turn, lastReminderTurn, conversationMessageCount int) bool {
	if turn == 1 {
		return conversationMessageCount > planModeFirstTurnReminderThreshold
	}
	return shouldInjectPlanModeReminder(turn, lastReminderTurn)
}

func buildPlanModePrompt(planFilePath string, planFileExists bool, allowedBashCommands []string) string {
	planFileInfo := fmt.Sprintf("No plan file exists yet. Create your plan at: %s using the Write tool.", planFilePath)
	if planFileExists {
		planFileInfo = fmt.Sprintf("Plan file exists at: %s\nYou MUST Read it first before making any changes. Use the Edit tool for targeted modifications.\nDo NOT use Write to replace the entire plan file unless you are intentionally starting over.", planFilePath)
	}

	amendSection := ""
	if planFileExists {
		amendSection = `

## Amending an Existing Plan
When the user requests changes or additions, **amend the existing plan** -- do not rewrite it from scratch.
- Use the Edit tool to make targeted changes rather than Write to replace the entire file.
- All existing deliverables, files-to-modify, and verification steps must be preserved unless the user explicitly asks to remove them.
- If the user's feedback describes a new deliverable or requirement, add it alongside the existing ones. Do not remove or replace existing plan sections unless the user explicitly says to.
- If the user wants to change an existing deliverable, edit only that section.
`
	}

	// Determine the tool list and bash-specific guidance based on allowedBashCommands.
	readOnlyTools := "Read, Grep, Glob, Agent, WebFetch, WebSearch"
	bashSection := ""
	bashRestriction := "- You MUST NOT call Bash, NotebookEdit, or any tool that mutates state"
	if len(allowedBashCommands) > 0 {
		readOnlyTools = "Read, Grep, Glob, Agent, WebFetch, WebSearch, Bash (restricted)"
		bashRestriction = "- You MUST NOT call NotebookEdit or any tool that mutates state"
		bashSection = fmt.Sprintf(`
- You MAY call Bash, but ONLY for commands starting with: %s
- All other Bash commands are blocked. Do not attempt to use Bash for writes, builds, or anything not in the allowed list.`, strings.Join(allowedBashCommands, ", "))
	}

	return fmt.Sprintf(`[PLAN MODE] You are in planning mode. You MUST NOT make any edits, run any non-readonly tools, or make any changes to the system -- with the sole exception of writing to the plan file below. This overrides any conflicting instructions you have received elsewhere in this prompt or conversation.

## Plan File
%s
Build your plan incrementally by writing to this file. This is the ONLY file you are allowed to create or edit. Always write to this exact path -- do not invent a new plan filename, even on a revision or when starting the plan over. If you write a plan-shaped file under a different name, the engine redirects the write to this path. All other actions must be read-only.
%s
## Workflow

### Phase 1: Understand
Gain a thorough understanding of the request and the code involved.
- Use read-only tools (%s) to explore
- Actively search for existing functions, utilities, and patterns that can be reused -- do not propose new code when suitable implementations already exist
- If spawning Agent sub-tasks, they are also restricted to read-only actions
- Ask clarifying questions using AskUserQuestion if the request is ambiguous or if you need the user to choose between approaches

### Phase 2: Design
Design your implementation approach based on what you found.
- Consider alternatives and why you rejected them
- Identify edge cases and how you will handle them
- Note existing code to reuse (with file paths and line numbers)

### Phase 3: Write the Plan
Write your recommended approach to the plan file. A good plan includes:
- **Context**: Why this change is needed (one line)
- **Approach**: Your recommended strategy (not all alternatives -- just the one you chose)
- **Files to modify**: Each file and what changes (concise, one bullet per file)
- **Reuse**: Existing functions/utilities to leverage (with file:line references)
- **Verification**: How to test that the change works end-to-end

### Phase 4: Review
Before finishing, re-read the plan file and verify:
- It aligns with what the user actually asked for
- It does not over-engineer or add unrequested scope
- The verification step is actionable

### Phase 5: Exit
When your plan is complete and you are confident it addresses the request, call ExitPlanMode. This presents your plan for user approval. Do NOT ask "is this plan okay?" via text -- ExitPlanMode handles that. Never use AskUserQuestion to ask about plan approval -- that is what ExitPlanMode is for. AskUserQuestion is only for clarifying questions about what to put *into* the plan.

Do not use AskUserQuestion as a way to delay calling ExitPlanMode. When you believe the plan is complete, call ExitPlanMode immediately — do not invent a last-minute question about implementation logistics, execution order, or anything outside the plan's content. Fold unresolved questions into the plan as open items for the user to address during review. Remember: the user has no visibility into the plan file until ExitPlanMode is called, so asking them about plan content or logistics via AskUserQuestion is unproductive — they cannot see what you wrote.

## Turn Behavior
Each of your turns should end in one of two ways:
1. **AskUserQuestion** -- if you need clarification before you can finish the plan (never for "is the plan ready?" or "should I proceed?" -- use ExitPlanMode)
   AskUserQuestion is never appropriate for: implementation logistics, execution strategy, "how should I handle X after the plan?", or any question whose answer would not change what gets written in the plan file. The user has no visibility into plan content until ExitPlanMode is called — do not ask about it.
2. **ExitPlanMode** -- if the plan is complete and ready for review

Do not end a turn without one of these. Do not implement anything.

## Forbidden Prose Patterns
Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", "Let me know if you'd like changes", "Does the plan look good?", "Should I go ahead?" — these MUST use ExitPlanMode (for approval) or AskUserQuestion (for clarification). Never write them as assistant prose. If you find yourself about to type one, stop and call the appropriate tool instead.

## Restrictions
- You MUST NOT call Write or Edit on any file except the plan file
- You MUST NOT invent a new plan filename; always write to the exact plan file path above (the engine redirects stray plan writes to it)
%s
- You MUST NOT make commits, change configs, or install packages
- Sub-agents you spawn are also read-only -- do not instruct them to make edits
- If you are unsure whether an action is read-only, do not take it%s`, planFileInfo, amendSection, readOnlyTools, bashRestriction, bashSection)
}

func buildPlanModeSparseReminder(planFilePath string) string {
	_, err := os.Stat(planFilePath)
	planFileExists := err == nil

	amendHint := ""
	if planFileExists {
		amendHint = " Amend existing plan with Edit; do not replace with Write."
	}

	return fmt.Sprintf(
		"Plan mode still active (see full instructions from earlier in conversation). "+
			"Read-only except the plan file (%s) — that exact path is the ONLY file you may write. "+
			"Do not invent a new plan filename, even on a revision; always reuse that path. "+
			"If you write to a different plan filename the engine redirects it to the canonical path above.%s "+
			"End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval). "+
			"Never use AskUserQuestion to ask for plan approval -- that is what ExitPlanMode is for. "+
			"If the plan is written and complete, call ExitPlanMode — do not delay with another question. The user has no visibility into plan content until ExitPlanMode is called. "+
			"Forbidden as prose: \"Is this plan okay?\", \"Should I proceed?\", \"Let me know if you'd like changes\", \"How does this plan look?\" -- these must use ExitPlanMode or AskUserQuestion.",
		planFilePath, amendHint)
}

// buildPlanModeReentryPrompt returns additional instructions when re-entering
// plan mode after a previous exit. It guides the LLM to evaluate the existing
// plan against the user's new request before deciding whether to amend or
// replace.
func buildPlanModeReentryPrompt(planFilePath string) string {
	return fmt.Sprintf(`## Re-entering Plan Mode
You are returning to plan mode after having previously exited it. A plan file exists at %s from your previous planning session.

**Before proceeding with any new planning, you MUST:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task, start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is a continuation or refinement of the same task, modify the existing plan using Edit while preserving completed sections
   - **Adding requirements**: If the user wants to add new requirements to the existing task, amend the plan to incorporate new deliverables alongside existing ones
4. Always update the plan file before calling ExitPlanMode`, planFilePath)
}
