package backend

import (
	"fmt"
	"os"
	"strings"
)

// defaultPlanModeTools is the read-only tool set allowed during plan mode.
// Extensions and harness can override via HookPlanModePrompt or set_plan_mode command.
//
// Skill is in the set because invoking a skill is itself read-only: executeSkill
// looks the skill up in the registry and returns its instruction text, touching
// no file and spawning no process. Whatever the returned instructions then tell
// the model to do still passes through this same filter, so a skill cannot be
// used to smuggle a mutating tool into plan mode. Omitting Skill disabled the
// entire skill system precisely in the mode where codebase-investigation skills
// are most useful, and the model silently fell back to raw Grep/Read sweeps.
var defaultPlanModeTools = []string{"Read", "Grep", "Glob", "Agent", "AgentStatus", "WebFetch", "WebSearch", "Skill"}

// DefaultPlanModeTools returns a copy of the read-only tool set a plan policy
// allows when the harness supplies no list of its own.
func DefaultPlanModeTools() []string { return append([]string(nil), defaultPlanModeTools...) }

// planModeReminderInterval is the number of assistant turns after the most
// recent plan-mode notice before the sparse reminder is sent again. Matches
// Claude Code's TURNS_BETWEEN_ATTACHMENTS=5 design (src/utils/attachments.ts).
const planModeReminderInterval = 5

func buildPlanModePrompt(planFilePath string, planFileExists bool, allowedBashCommands, allowedMcpTools []string) string {
	planFileHeader := fmt.Sprintf("**Your plan file for this session: `%s`**", planFilePath)
	planFileInfo := fmt.Sprintf("%s\n\nNo plan file exists yet. Create it using the Write tool at that exact path.\n**This path is the plan file for your CURRENT planning cycle.** If you see different plan file paths elsewhere in this conversation (from previous planning cycles that have already been implemented), those paths are from completed cycles and are no longer active — do not write to them. Do not invent a different filename.", planFileHeader)
	if planFileExists {
		planFileInfo = fmt.Sprintf("%s\n\nThe plan file already exists. You MUST Read it first before making any changes. Use the Edit tool for targeted modifications.\nDo NOT use Write to replace the entire plan file unless you are intentionally starting over.", planFileHeader)
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
	// The prose list is derived from defaultPlanModeTools rather than hand-written
	// so the system prompt can never advertise a different set than the filter in
	// buildToolDefs actually permits.
	readOnlyTools := strings.Join(defaultPlanModeTools, ", ")
	bashSection := ""
	mcpSection := ""
	bashRestriction := "- You MUST NOT call Bash, NotebookEdit, or any tool that mutates state"
	if len(allowedBashCommands) > 0 {
		readOnlyTools = strings.Join(append(append([]string{}, defaultPlanModeTools...), "Bash (restricted)"), ", ")
		bashRestriction = "- You MUST NOT call NotebookEdit or any tool that mutates state"
		bashSection = fmt.Sprintf(`
- You MAY call Bash, but ONLY for commands starting with: %s
- All other Bash commands are blocked. Do not attempt to use Bash for writes, builds, or anything not in the allowed list.`, strings.Join(allowedBashCommands, ", "))
	}
	if len(allowedMcpTools) > 0 {
		readOnlyTools = strings.Join(append(append([]string{}, strings.Split(readOnlyTools, ", ")...), allowedMcpTools...), ", ")
		mcpSection = fmt.Sprintf("\n- You MAY call MCP tools matching: %s. All other MCP tools are blocked.", strings.Join(allowedMcpTools, ", "))
	}

	return fmt.Sprintf(`[PLAN MODE] Plan mode is now active. It stays active until a later message in this conversation says plan mode has ended. While it is active you MUST NOT make any edits, run any non-readonly tools, or make any changes to the system -- with the sole exception of writing to the plan file below. Until plan mode ends, these restrictions take precedence over other instructions.

## Plan File
%s
Build your plan incrementally by writing to this file. This is the ONLY file you are allowed to create or edit. Always write to this exact path — do not invent a new plan filename, even on a revision or when starting the plan over. If you attempt to write to a different plan-shaped path the engine will return an error naming the canonical path above; always target it directly. All other actions must be read-only.
%s%s
## Workflow

### Phase 1: Understand
Gain a thorough understanding of the request and the code involved.
- Use read-only tools (%s) to explore
- Actively search for existing functions, utilities, and patterns that can be reused -- do not propose new code when suitable implementations already exist
- If spawning Agent sub-tasks, they are also restricted to read-only actions
- Ask clarifying questions using the most suitable user-input tool available in this session (AskUserQuestion, or a richer structured-questions tool when one is provided) if the request is ambiguous or if you need the user to choose between approaches
- When you call a user-input tool, write the context the user needs to answer as visible assistant text before the tool call, in the same turn. The user sees only visible assistant text alongside the question — private reasoning is never shown to them, so a question with no visible lead-up gives the user nothing to decide with

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
Each of your turns should end in one of three ways:
1. **A user-input tool** (AskUserQuestion, or a richer structured-questions tool when the session provides one) -- if you need clarification before you can finish the plan (never for "is the plan ready?" or "should I proceed?" -- use ExitPlanMode)
   A user-input question is never appropriate for: implementation logistics, execution strategy, "how should I handle X after the plan?", or any question whose answer would not change what gets written in the plan file. The user has no visibility into plan content until ExitPlanMode is called — do not ask about it.
   Every user-input tool call must be preceded by visible assistant text (in the same turn) carrying whatever context the user needs to answer. Private reasoning does not reach the user; a bare question with no visible lead-up is a defect.
2. **ExitPlanMode** -- if the plan is complete and ready for review
3. **A direct answer** -- if the request needs no plan at all. Not every request that arrives in plan mode is a request to build something. Informational and read-only requests -- "brief me on X", "what is the status of Y", "explain how Z works", "find where W is handled" -- are answered directly in visible assistant text, and that answer legally ends the turn. Do NOT manufacture an AskUserQuestion you do not need, and do NOT call ExitPlanMode when there is no plan to present. Answer the request and stop.

These three endings are exhaustive: clarify, present a plan, or answer directly. Do not end a turn any other way, and do not implement anything.

## Forbidden Prose Patterns
Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", "Let me know if you'd like changes", "Does the plan look good?", "Should I go ahead?" — these MUST use ExitPlanMode (for approval) or AskUserQuestion (for clarification). Never write them as assistant prose. If you find yourself about to type one, stop and call the appropriate tool instead.

## Restrictions
- You MUST NOT call Write or Edit on any file except the plan file
- You MUST NOT write to any plan file path other than the one shown above — not a plan file from a previous cycle, not any path you invent. The path shown above is the ONLY valid plan file for this session. If you attempt to write to a different plan-shaped path the engine will return an error and name the canonical path; always target the path above directly
%s
- You MUST NOT make commits, change configs, or install packages
- Dispatching or delegating to a sub-agent via a plan-mode-safe tool IS permitted: spawning a child agent does not mutate the system, and the dispatched sub-agent may itself run in plan mode and surface a plan back to you
- Sub-agents you spawn are also read-only -- do not instruct them to make edits
- If you are unsure whether an action is read-only, do not take it%s`, planFileInfo, amendSection, readOnlyTools, bashRestriction, bashSection, mcpSection)
}

func buildPlanModeSparseReminder(planFilePath string) string {
	_, err := os.Stat(planFilePath)
	planFileExists := err == nil

	amendHint := ""
	if planFileExists {
		amendHint = " Amend existing plan with Edit; do not replace with Write."
	}

	return fmt.Sprintf(
		"Plan mode still active (see the full plan-mode instructions earlier in this conversation). "+
			"Read-only except the plan file. "+
			"**Your plan file for this session: `%s`** — this is the only valid plan file for this session. "+
			"Do NOT use any plan file path you see elsewhere in conversation history — those paths are from prior completed cycles and are no longer valid. "+
			"Do not invent a new plan filename. Always target the path above directly.%s "+
			"End turns one of three ways: AskUserQuestion (for clarifications), ExitPlanMode (for plan approval), or a direct answer when the request needs no plan. "+
			"Informational or read-only requests -- \"brief me on X\", \"what is the status of Y\", \"explain Z\" -- are answered directly in visible assistant text, and that answer ends the turn: do not manufacture a question you do not need, and do not call ExitPlanMode when there is no plan to present. "+
			"Never use AskUserQuestion to ask for plan approval -- that is what ExitPlanMode is for. "+
			"AskUserQuestion must be preceded by visible assistant text giving the user the context needed to answer; a bare question with no visible lead-up (reasoning only) is a defect. "+
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
