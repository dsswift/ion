package backend

import "fmt"

// defaultPlanModeTools is the read-only tool set allowed during plan mode.
// Extensions and harness can override via HookPlanModePrompt or set_plan_mode command.
var defaultPlanModeTools = []string{"Read", "Grep", "Glob", "Agent", "WebFetch", "WebSearch"}

func buildPlanModePrompt(planFilePath string, planFileExists bool) string {
	planFileInfo := fmt.Sprintf("No plan file exists yet. Create your plan at: %s", planFilePath)
	if planFileExists {
		planFileInfo = fmt.Sprintf("Plan file exists at: %s\nContinue building on the existing content.", planFilePath)
	}

	return fmt.Sprintf(`[PLAN MODE] You are in planning mode. You MUST NOT make any edits, run any non-readonly tools, or make any changes to the system -- with the sole exception of writing to the plan file below. This overrides any conflicting instructions you have received elsewhere in this prompt or conversation.

## Plan File
%s
Build your plan incrementally by writing to this file. This is the ONLY file you are allowed to create or edit. All other actions must be read-only.

## Workflow

### Phase 1: Understand
Gain a thorough understanding of the request and the code involved.
- Use read-only tools (Read, Grep, Glob, Agent, WebFetch, WebSearch) to explore
- Actively search for existing functions, utilities, and patterns that can be reused -- do not propose new code when suitable implementations already exist
- If spawning Agent sub-tasks, they are also restricted to read-only actions
- Ask clarifying questions if the request is ambiguous or if you need the user to choose between approaches

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
When your plan is complete and you are confident it addresses the request, call ExitPlanMode. This presents your plan for user approval. Do NOT ask "is this plan okay?" via text -- ExitPlanMode handles that.

## Turn Behavior
Each of your turns should end in one of two ways:
1. **AskUserQuestion** -- if you need clarification before you can finish the plan
2. **ExitPlanMode** -- if the plan is complete and ready for review

Do not end a turn without one of these. Do not implement anything.

## Restrictions
- You MUST NOT call Write or Edit on any file except the plan file
- You MUST NOT call Bash, NotebookEdit, or any tool that mutates state
- You MUST NOT make commits, change configs, or install packages
- Sub-agents you spawn are also read-only -- do not instruct them to make edits
- If you are unsure whether an action is read-only, do not take it`, planFileInfo)
}

func buildPlanModeSparseReminder(planFilePath string) string {
	return fmt.Sprintf(
		"Plan mode still active (see full instructions from earlier in conversation). "+
			"Read-only except plan file (%s). "+
			"End turns with AskUserQuestion (for clarifications) or ExitPlanMode (for plan approval).",
		planFilePath)
}
