package backend

import (
	"fmt"
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

// CliExitPlanModeTool returns the metadata for the engine-owned ExitPlanMode
// tool that wirePlanModeToolServer registers on a delegated claude-code
// plan-mode run's MCP ToolServer. Unlike the ApiBackend's no-arg sentinel
// (tools.ExitPlanModeTool), the CLI variant carries the plan markdown as its
// `plan` argument: the CLI plan run is read-only with no file-writing tools, so
// the plan cannot be written to a file and is instead captured from this
// argument in handlePlanModeAssistant.
func CliExitPlanModeTool() (name, description string, inputSchema map[string]any) {
	return tools.ExitPlanModeName,
		"Signal that planning is complete and present your plan for user approval. Pass the full plan markdown as the `plan` argument. This is the only way to surface your plan; call it exactly once, when the plan is ready.",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"plan": map[string]any{
					"type":        "string",
					"description": "The complete plan markdown to present for approval.",
				},
			},
			"required": []string{"plan"},
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
// An override should keep instructing the model to deliver its plan through the
// ExitPlanMode `plan` argument: the CLI plan run is read-only with no
// file-writing tools, so a prompt that tells the model to Write a plan file
// (as the API-backend default does) would leave the plan uncaptured.
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
// delegated claude-code run's --append-system-prompt. It differs from the
// ApiBackend's buildPlanModePrompt in exactly one mechanism: the CLI plan run is
// read-only and has NO file-writing tools, so the model delivers its finished
// plan as the ExitPlanMode `plan` argument rather than writing a plan file.
// Everything else — read-only exploration, the three legal turn endings, the
// forbidden approval-prose patterns — matches the API path. The read-only tool
// list is derived from defaultPlanModeTools so it can never drift from the set
// the API backend advertises.
func buildCliPlanModePrompt(planFilePath string, planFileExists bool) string {
	readOnlyTools := strings.Join(defaultPlanModeTools, ", ")
	priorPlan := ""
	if planFileExists && planFilePath != "" {
		priorPlan = fmt.Sprintf("\n\nA plan file from a previous cycle exists at `%s`. You MAY Read it for context, but you cannot write to it — deliver your updated plan through ExitPlanMode as described below.", planFilePath)
	}
	return fmt.Sprintf(`[PLAN MODE] You are in planning mode. You MUST NOT make any edits or run any tool that mutates state, and you have no file-writing tools in this mode. This overrides any conflicting instructions elsewhere in this prompt or conversation.%s

## Delivering Your Plan
You cannot write files. When your plan is complete, call ExitPlanMode and pass the full plan markdown as its `+"`plan`"+` argument. That single call presents the plan for user approval — it is the ONLY way to surface your plan. Do not paste the plan as plain assistant text and stop; it will not be captured.

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
Call ExitPlanMode with a `+"`plan`"+` argument that includes:
- **Context**: why this change is needed (one line)
- **Approach**: the strategy you chose (not every alternative)
- **Files to modify**: each file and its change, one bullet per file
- **Reuse**: existing functions/utilities to leverage (file:line)
- **Verification**: how to test the change end-to-end

## Turn Behavior
Each turn ends one of exactly three ways:
1. **AskUserQuestion** — a clarifying question you need answered before you can finish the plan (never "is the plan ready?" or "should I proceed?" — that is ExitPlanMode). Precede every such call with visible assistant text carrying the context the user needs.
2. **ExitPlanMode** — the plan is complete; deliver it in the `+"`plan`"+` argument.
3. **A direct answer** — the request needs no plan (informational or read-only: "brief me on X", "what is the status of Y", "explain Z"). Answer in visible assistant text and stop; do not manufacture a question and do not call ExitPlanMode when there is no plan to present.

Do not end a turn any other way, and do not implement anything.

## Forbidden Prose Patterns
"Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", "Let me know if you'd like changes" — never write these as assistant prose. Use ExitPlanMode (for approval) or AskUserQuestion (for clarification) instead.`, priorPlan, readOnlyTools)
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
		// The model exited plan mode but the stream never yielded a plan
		// argument nor a plans-file write to capture. Surface the proposal so
		// consumers still render the approval card against the (possibly empty)
		// plan file.
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "exit without captured plan, proposal surfaced (per ADR-003 mode change deferred to user approval)", map[string]any{
			"run_id": run.requestID, "plan_file": run.planFilePath,
		})

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
