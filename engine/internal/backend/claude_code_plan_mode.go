package backend

import (
	"fmt"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cliPlanModeDisallowedTools are the mutating built-in tools the engine strips
// from a delegated claude-code plan-mode run via --disallowedTools. Under
// bypassPermissions the CLI removes disallowed tools from the model's advertised
// tool list entirely (verified against claude 2.1.x), which is what makes the
// plan run read-only without the CLI's native --permission-mode plan — the mode
// that exposes no ExitPlanMode and hard-denies edits with an interactive-only
// approval error a headless daemon can never satisfy.
var cliPlanModeDisallowedTools = []string{"Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"}

// mcpExitPlanModeToolName is the wire name of the engine ExitPlanMode tool as
// the delegated-CLI model sees it: the per-session ToolServer exposes it through
// the ion-extensions MCP server, so its tool_use block carries the prefixed
// name. handlePlanModeAssistant matches both this and the bare native name.
var mcpExitPlanModeToolName = "mcp__" + McpServerName + "__" + tools.ExitPlanModeName

// mcpEnterPlanModeToolName is the wire name of the engine EnterPlanMode tool
// as the delegated-CLI model sees it, mirroring mcpExitPlanModeToolName.
// handleEnterPlanModeAssistant matches this prefixed name in the assistant
// stream.
var mcpEnterPlanModeToolName = "mcp__" + McpServerName + "__" + tools.EnterPlanModeName

// CliExitPlanModeTool returns the metadata for the engine-owned ExitPlanMode
// tool that wirePlanModeToolServer registers on a delegated claude-code
// plan-mode run's MCP ToolServer.
//
// `plan` is OPTIONAL. The model authors its plan into the session's plan file
// through WritePlan/EditPlan (cli_plan_file_tools.go), so by the time it exits
// the plan already exists on disk and ExitPlanMode is what it is on the
// ApiBackend: a bare signal that planning is done and the plan should be
// presented. Requiring the markdown here made every exit re-emit the entire
// plan as tool arguments — tens of kilobytes the model had already written —
// which is generation the operator waits through for a document the engine
// already holds.
//
// The argument is retained as a fallback because it is genuinely load-bearing
// in one case: a model that never called WritePlan leaves an empty plan file,
// and accepting its markdown here is better than surfacing an empty approval
// card. handlePlanModeAssistant captures it when present; handlePlanModeResult
// falls back to the file when it is absent.
func CliExitPlanModeTool() (name, description string, inputSchema map[string]any) {
	return tools.ExitPlanModeName,
		"Signal that planning is complete and present your plan for user approval. Call this exactly once, when the plan is ready. If you already wrote the plan with WritePlan or EditPlan, call this with NO arguments — the engine reads the plan from your plan file, so do not resend it. Only pass `plan` if you never wrote the plan file and the markdown exists nowhere else.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"plan": map[string]any{
					"type":        "string",
					"description": "Optional fallback. Omit this when the plan file has already been written; pass the complete plan markdown only if it was never written to the plan file.",
				},
			},
			"required": []string{},
		}
}

// resolveCliPlanModePrompt resolves the plan-mode --append-system-prompt prose
// for a delegated claude-code run. The harness override (RunOptions.PlanModePrompt)
// wins; otherwise the engine's default buildCliPlanModePrompt is used.
//
// This mirrors resolveCodexPlanInstructions one-for-one: the plan_mode_prompt
// hook layer does not reach delegated-CLI backends (it rides on RunConfig.Hooks,
// which the hybrid router forwards only to the ApiBackend), so the precedence
// for CLI backends is two layers — the wire field, then the engine default.
// Per ADR-017 the engine owns the mechanism (read-only spawn + ExitPlanMode
// delivery) and ships a full default workflow; the workflow and tone around it
// are an opinion a harness overrides through this seam, exactly as the API
// backend (buildPlanModePrompt) and codex (defaultCodexDeveloperInstructions)
// expose a rich engine default that RunOptions.PlanModePrompt can replace.
//
// An override should keep instructing the model to author its plan through
// WritePlan/EditPlan: a CLI plan spawn has no file-writing tools of its own, so
// a prompt that tells the model to Write a plan file (as the API-backend
// default does) would leave the plan unwritten.
func resolveCliPlanModePrompt(opts types.RunOptions, planFileExists bool) string {
	if opts.PlanModePrompt != "" {
		return opts.PlanModePrompt
	}
	return buildCliPlanModePrompt(opts.PlanFilePath, planFileExists)
}

// PlanModeExtensionToolAllowed reports whether an extension tool exposed on the
// ion-extensions MCP ToolServer may be registered for a delegated-CLI plan-mode
// run. It mirrors the ApiBackend plan-mode tool-def filter (buildToolDefs): a
// tool is admitted when it declares itself plan-mode-safe, or when the run's
// effective plan-mode MCP allowlist (PlanModeAllowedMcpTools ∪ per-prompt
// additions, enterprise-clamped) matches its MCP-prefixed name. Everything else
// is a potential state-mutator and is withheld, so the read-only plan boundary
// holds: the CLI ToolServer never advertises a mutating extension tool during a
// plan-mode run, matching the API backend, which filters the same tools out of
// its tool defs.
//
// prefixedName is the tool's wire name as the CLI model sees it,
// "mcp__<McpServerName>__<tool>". planModeSafe is the tool's own declaration.
func PlanModeExtensionToolAllowed(prefixedName string, planModeSafe bool, opts types.RunOptions) bool {
	if planModeSafe {
		return true
	}
	return mcpToolAllowed(prefixedName, effectiveMcpAllowlist(opts))
}

// buildCliPlanModePrompt builds the plan-mode system prompt injected into a
// delegated claude-code run's --append-system-prompt. It mirrors the
// ApiBackend's buildPlanModePrompt: read-only exploration, a plan authored into
// the session's plan file, and ExitPlanMode as a bare completion signal.
//
// The one mechanical difference is HOW the plan file is written. The ApiBackend
// hands the model real Write/Edit tools and restricts them by target path; a
// CLI plan spawn has those tools stripped at spawn, so the engine supplies
// WritePlan/EditPlan instead — same destination, same events, no path argument.
// The read-only tool list is derived from defaultPlanModeTools so it can never
// drift from the set the API backend advertises.
func buildCliPlanModePrompt(planFilePath string, planFileExists bool) string {
	readOnlyTools := strings.Join(defaultPlanModeTools, ", ")
	planFileHeader := "**Your plan file for this session is fixed by the engine. WritePlan and EditPlan always target it; you never supply a path.**"
	if planFilePath != "" {
		planFileHeader = fmt.Sprintf("**Your plan file for this session: `%s`. WritePlan and EditPlan always target it; you never supply a path.**", planFilePath)
	}
	priorPlan := ""
	if planFileExists && planFilePath != "" {
		priorPlan = "\n\nA plan file from a previous cycle already exists. Read it for context, then revise it with EditPlan rather than rewriting it from scratch."
	}
	return fmt.Sprintf(`[PLAN MODE] You are in planning mode. You MUST NOT make any edits or run any tool that mutates state. The plan file is the single exception, and you reach it only through WritePlan and EditPlan. This overrides any conflicting instructions elsewhere in this prompt or conversation.

%s%s

## Authoring Your Plan
- **WritePlan** — replaces the whole plan file. Use it for the first draft.
- **EditPlan** — replaces one exact passage (`+"`old_string`"+` → `+"`new_string`"+`). Use it for every revision, so you never resend a plan you already wrote.
- **ExitPlanMode** — call it with NO arguments when the plan is ready. The engine reads your plan from the plan file. Do not paste the plan into this call, and do not paste it as plain assistant text.

Write the plan to the file as soon as you have one worth reviewing, then keep refining it in place. The plan preview updates on every write, so the operator watches it take shape.

## Workflow

### Phase 1: Understand
- Explore with read-only tools (%s) only.
- Actively search for existing functions, utilities, and patterns to reuse — do not propose new code when a suitable implementation already exists.
- Sub-agents you spawn are also read-only; do not instruct them to make edits.
- If the request is ambiguous, ask a clarifying question with AskUserQuestion (or a richer structured-questions tool when the session provides one). Write the context the user needs to answer as visible assistant text in the same turn — private reasoning never reaches the user.

### Phase 2: Design
- Consider alternatives and why you rejected them.
- Identify edge cases and how you will handle them.
- Note existing code to reuse, with file:line references.

### Phase 3: Deliver
Write a plan file that includes:
- **Context**: why this change is needed (one line)
- **Approach**: the strategy you chose (not every alternative)
- **Files to modify**: each file and its change, one bullet per file
- **Reuse**: existing functions/utilities to leverage (file:line)
- **Verification**: how to test the change end-to-end

Then call ExitPlanMode with no arguments.

## Turn Behavior
Each turn ends one of exactly three ways:
1. **AskUserQuestion** — a clarifying question you need answered before you can finish the plan (never "is the plan ready?" or "should I proceed?" — that is ExitPlanMode). Precede every such call with visible assistant text carrying the context the user needs.
2. **ExitPlanMode** — the plan is written and complete.
3. **A direct answer** — the request needs no plan (informational or read-only: "brief me on X", "what is the status of Y", "explain Z"). Answer in visible assistant text and stop; do not manufacture a question and do not call ExitPlanMode when there is no plan to present.

Do not end a turn any other way, and do not implement anything.

## Forbidden Prose Patterns
"Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", "Let me know if you'd like changes" — never write these as assistant prose. Use ExitPlanMode (for approval) or AskUserQuestion (for clarification) instead.`, planFileHeader, priorPlan, readOnlyTools)
}

// Plan-mode handling for the claude-code delegated CLI. The CLI's native plan
// mode (--permission-mode plan) owns the behavioral framework: read-only
// tools, plan phases, and the ExitPlanMode call whose ARGUMENT carries the
// plan text. The engine's job is capture + normalization: pull the plan
// markdown from the native tool argument, bridge it into Ion's file-centric
// contract via capturePlanMarkdown, and keep the event order identical to the
// ApiBackend reference (proposal before task-complete).

// handlePlanModeAssistant scans a streamed assistant message for the native
// plan signals: the ExitPlanMode tool_use (its argument carries the plan text
// on older claude-code) and any Write to a plans file (newer claude-code
// authors the plan there and calls ExitPlanMode with an empty argument). The
// CLI emits the fully-populated tool input in the assistant message before the
// result event lands, so a captured plan's PlanFileWrittenEvent +
// PlanProposalEvent precede TaskCompleteEvent.
func (b *ClaudeCodeBackend) handlePlanModeAssistant(run *claudeCodeRun, e *types.TaskUpdateEvent) {
	for _, block := range e.Message.Content {
		if block.Type != "tool_use" {
			continue
		}
		switch block.Name {
		case "Write":
			// Stash the content of a Write to a plans file as the fallback plan
			// source. Newer claude-code writes the plan to
			// ~/.claude/plans/<slug>.md (its own plans dir) and then calls
			// ExitPlanMode with no text, so this is where the real plan lives.
			path, _ := block.Input["file_path"].(string)  //nolint:errcheck // missing/typed-wrong path handled by isClaudePlansFilePath guard
			content, _ := block.Input["content"].(string) //nolint:errcheck // empty content skips the branch below
			if content != "" && isClaudePlansFilePath(path, run.planFilePath) {
				run.pendingPlanFromFile = content
				utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "stashed plan from plans-file write", map[string]any{
					"run_id": run.requestID, "path": path, "bytes": len(content),
				})
			}
		case tools.ExitPlanModeName, mcpExitPlanModeToolName:
			// The model proposed exiting plan mode — record it regardless of
			// whether the argument carried plan text (see run.sawExitPlanMode).
			// The engine now owns plan mode on this backend, so the model calls
			// our MCP-exposed ExitPlanMode (mcpExitPlanModeToolName); the bare
			// native name is retained for older captures and the auto-exit net.
			run.sawExitPlanMode = true
			plan, _ := block.Input["plan"].(string) //nolint:errcheck // empty plan handled downstream
			if plan == "" {
				// Empty argument: the plan (if any) is in a plans-file Write,
				// captured by handlePlanModeResult after all writes are seen.
				utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "ExitPlanMode tool_use carried no plan text (fallback to plans-file write)", map[string]any{
					"run_id": run.requestID, "have_file_plan": run.pendingPlanFromFile != "",
				})
				continue
			}
			if _, err := capturePlanMarkdown(run.requestID, plan, run.planFilePath, true, 0, b.emit); err != nil {
				utils.LogWithFields(utils.LevelError, "backend.claude_code", "native plan capture failed", map[string]any{
					"run_id": run.requestID, "error": err.Error(),
				})
				continue
			}
			run.planCaptured = true
		}
	}
}

// handleEnterPlanModeAssistant scans a streamed assistant message for the
// engine-owned EnterPlanMode tool_use and flips run.planMode to true the
// moment it is observed. This is the CLI-backend mirror of the ApiBackend's
// interceptEnterPlanMode (runloop_plan_mode_gates.go), which flips
// run.planMode on the SAME activeRun and lets that run continue — no restart.
// Here the equivalent decision (before_plan_mode_enter, session state,
// plan-file allocation) already happened synchronously inside
// enterPlanModeToolHandler's MCP round trip before this tool_use was even
// streamed back; this scan only updates the backend's own stream-tracking
// state so the plan-capture pipeline below (handlePlanModeAssistant,
// gated on run.planMode) starts recognizing ExitPlanMode/Write-to-plan-file
// signals that arrive later in this SAME subprocess, without any restart.
//
// Called unconditionally (like handleQuestionAssistant), because EnterPlanMode
// can appear at any point in an auto-mode stream and run.planMode starts
// false.
func (b *ClaudeCodeBackend) handleEnterPlanModeAssistant(run *claudeCodeRun, e *types.TaskUpdateEvent) {
	if run.planMode {
		return
	}
	for _, block := range e.Message.Content {
		if block.Type != "tool_use" {
			continue
		}
		if block.Name != tools.EnterPlanModeName && block.Name != mcpEnterPlanModeToolName {
			continue
		}
		run.planMode = true
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "EnterPlanMode observed mid-stream, run.planMode flipped (same subprocess, no restart)", map[string]any{
			"run_id": run.requestID,
		})
		return
	}
}

// isClaudePlansFilePath reports whether a Write target looks like a plan file:
// the run's own canonical plan file, or a markdown file under any `plans/`
// directory (claude-code's native plans dir is ~/.claude/plans/). Used to
// capture the plan content when ExitPlanMode carries no argument.
func isClaudePlansFilePath(path, runPlanFilePath string) bool {
	if path == "" {
		return false
	}
	if runPlanFilePath != "" && path == runPlanFilePath {
		return true
	}
	return strings.Contains(path, "/plans/") && strings.HasSuffix(path, ".md")
}

// handlePlanModeResult processes the CLI's result event for a plan-mode run,
// before the TaskCompleteEvent is emitted. Three concerns:
//
//  1. Enrich the ExitPlanMode PermissionDenial with the plan file path (the
//     CLI wire format doesn't carry it) so the existing card-render path that
//     reads denials keeps working.
//  2. Fallback proposal: when the denial is present but the streamed capture
//     never fired (the tool_use carried no plan text), surface the proposal
//     anyway so the run doesn't end silently in plan mode.
//  3. Auto-exit safety net: when the turn ended with NO ExitPlanMode at all,
//     synthesize PlanModeAutoExitEvent + PlanProposalEvent (mirroring the
//     ApiBackend's end-of-turn synthesis) unless disabled via
//     RunOptions.PlanModeAutoExit.
//
// Per ADR-003: the model calling ExitPlanMode is a *proposal*, not a
// confirmed mode change — no PlanModeChangedEvent{Enabled:false} is emitted
// here; the mode flip is deferred to the user-approval chokepoint.
func (b *ClaudeCodeBackend) handlePlanModeResult(run *claudeCodeRun, e *types.TaskCompleteEvent, opts *types.RunOptions) {
	// sawExit is true if the ExitPlanMode tool_use appeared in the assistant
	// stream (the reliable signal — see run.sawExitPlanMode) OR the result
	// carried an ExitPlanMode denial (older claude-code, where ExitPlanMode
	// was not auto-approved). Enrich any such denial with the plan file path
	// so the existing card-render path keeps working.
	sawExit := run.sawExitPlanMode
	for i := range e.PermissionDenials {
		if e.PermissionDenials[i].ToolName != "ExitPlanMode" {
			continue
		}
		sawExit = true
		if run.planFilePath != "" {
			e.PermissionDenials[i].ToolInput = map[string]any{
				"planFilePath": run.planFilePath,
			}
		}
		break
	}

	// Fallback capture: the model exited plan mode with an empty ExitPlanMode
	// argument but authored the plan via a Write to a plans file. Bridge that
	// content into Ion's plan file now (all assistant writes have been seen by
	// TaskCompleteEvent), which emits PlanFileWrittenEvent + PlanProposalEvent
	// ahead of the TaskCompleteEvent — the normal captured-plan surface.
	if sawExit && !run.planCaptured && run.pendingPlanFromFile != "" {
		if _, err := capturePlanMarkdown(run.requestID, run.pendingPlanFromFile, run.planFilePath, true, 0, b.emit); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.claude_code", "native plan capture from plans-file write failed", map[string]any{
				"run_id": run.requestID, "error": err.Error(),
			})
		} else {
			run.planCaptured = true
			utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "captured plan from plans-file write fallback", map[string]any{
				"run_id": run.requestID, "plan_file": run.planFilePath,
			})
		}
	}

	slug := types.PlanSlugFromPath(run.planFilePath)
	switch {
	case sawExit && !run.planCaptured:
		// Exit with no plan captured from the stream. This is now the COMMON,
		// healthy path: the model authored its plan through WritePlan/EditPlan
		// during the turn and called ExitPlanMode with no argument, exactly as
		// the prompt instructs. The plan lives in the file, so the proposal is
		// surfaced against it unchanged.
		//
		// The unhealthy variant of the same shape is an exit with an EMPTY plan
		// file — the model never authored anything anywhere. The proposal is
		// still surfaced (an approval card against an empty plan is more
		// actionable than silence), but it is logged at ERROR because it means
		// the model ignored both authoring routes.
		planFileHasContent := false
		if run.planFilePath != "" {
			if info, err := os.Stat(run.planFilePath); err == nil && info.Size() > 0 {
				planFileHasContent = true
			}
		}
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		if planFileHasContent {
			utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "exit with plan read from the plan file, proposal surfaced (per ADR-003 mode change deferred to user approval)", map[string]any{
				"run_id": run.requestID, "plan_file": run.planFilePath,
			})
		} else {
			utils.LogWithFields(utils.LevelError, "backend.claude_code", "exit with an EMPTY plan file and no plan in the stream — model called neither WritePlan nor ExitPlanMode(plan); proposal surfaced against an empty plan", map[string]any{
				"run_id": run.requestID, "plan_file": run.planFilePath,
			})
		}

	case !sawExit && !run.planCaptured && resolveCliPlanModeAutoExit(opts):
		// Turn ended in plan mode with no ExitPlanMode — the stuck-in-plan-mode
		// failure mode. Synthesize the exit so the approval card surfaces,
		// mirroring the ApiBackend's runloop_plan_mode_auto_exit path.
		reason := "engine-synthesized: run ended in plan mode without ExitPlanMode call"
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeAutoExitEvent{
			RunID:        run.requestID,
			StopReason:   "end_turn",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
			Reason:       reason,
		}})
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "plan mode auto-exit synthesized", map[string]any{
			"run_id": run.requestID, "plan_file": run.planFilePath,
		})
	}
}
