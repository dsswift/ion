package backend

import (
	"os"
	"strconv"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cliResumeArgs returns the `--resume <uuid>` argument pair for a CLI run,
// or nil when the run must start a fresh claude session.
//
// The resume id is sourced *only* from opts.CliResumeSessionID — the
// claude-native session UUID the manager captured from a previous run's
// SessionInitEvent/TaskCompleteEvent. It is never sourced from
// opts.ConversationID (Ion's `{millis}-{12hex}` conversation-file identity),
// which the claude CLI rejects with exit code 1.
//
// Contract:
//   - First run of a session (CliResumeSessionID == ""): returns nil, so the
//     backend omits --resume and claude starts a fresh session.
//   - Subsequent runs (CliResumeSessionID set): returns {"--resume", "<uuid>"}.
//
// Both branches log so the resume decision is reconstructible from
// ~/.ion/engine.log alone.
func cliResumeArgs(opts types.RunOptions) []string {
	if opts.CliResumeSessionID != "" {
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "resume: --resume", map[string]any{
			"cli_resume_session_id": opts.CliResumeSessionID,
		})
		return []string{"--resume", opts.CliResumeSessionID}
	}
	// First run of this session: no claude UUID captured yet. Omitting
	// --resume is mandatory — claude rejects a missing/invalid resume id.
	// SessionID (Ion's conversation id) is intentionally NOT used here.
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "resume: omitting --resume (first CLI run, no captured claude session UUID; )", map[string]any{
		"conversation_id": opts.ConversationID,
	})
	return nil
}

// buildClaudeArgs assembles the argv for the claude CLI subprocess from a run's
// options. It is extracted from runProcess so the plan-mode spawn contract is
// unit-testable without launching a process.
//
// Permission model:
//   - Default (and auto mode) spawns "bypassPermissions". The engine is
//     security-free by design; the harness owns any approval layer via hooks.
//     A caller may override via opts.PermissionModeCli.
//   - Plan mode does NOT use the CLI's native "--permission-mode plan". Headless
//     `claude -p --permission-mode plan` exposes no ExitPlanMode tool (the model
//     can never signal completion) and hard-denies every Write/Edit with an
//     interactive-approval error that no headless daemon can satisfy. Instead the
//     engine OWNS plan mode, mirroring the ApiBackend: spawn read-only under
//     bypassPermissions with the mutating tools removed via --disallowedTools
//     (verified against claude 2.1.x to drop them from the model's advertised
//     tool list entirely), inject the plan prompt, and expose an engine
//     ExitPlanMode through the MCP ToolServer (see wirePlanModeToolServer).
func buildClaudeArgs(opts types.RunOptions) []string {
	args := []string{
		"-p",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}

	permMode := "bypassPermissions"
	if !opts.PlanMode && opts.PermissionModeCli != "" {
		permMode = opts.PermissionModeCli
	}
	args = append(args, "--permission-mode", permMode)
	if opts.PlanMode {
		// The read-only boundary: under bypassPermissions the CLI strips these
		// from the advertised tool list, so the model cannot mutate state and
		// never hits the interactive-approval denial that broke native plan mode.
		args = append(args, "--disallowedTools", strings.Join(cliPlanModeDisallowedTools, ","))
	}

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.MaxTurns > 0 {
		args = append(args, "--max-turns", strconv.Itoa(opts.MaxTurns))
	}
	if opts.MaxBudgetUsd > 0 {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(opts.MaxBudgetUsd, 'f', -1, 64))
	}
	// Resume only with claude's own captured session UUID (CliResumeSessionID),
	// never with Ion's conversation id (opts.ConversationID). See cliResumeArgs.
	args = append(args, cliResumeArgs(opts)...)
	for _, dir := range opts.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}

	// Append-system-prompt: the plan-mode prose (plan mode only) followed by any
	// caller-supplied append text (e.g. the MCP tool-alias directive from
	// wirePlanModeToolServer). resolveCliPlanModePrompt applies the harness seam:
	// RunOptions.PlanModePrompt wins, else the engine default. Because the plan
	// run is read-only with no file-writing tools, the engine default instructs
	// the model to deliver its finished plan as the ExitPlanMode `plan` argument.
	appendPrompt := opts.AppendSystemPrompt
	if opts.PlanMode {
		_, statErr := os.Stat(opts.PlanFilePath)
		planPrompt := resolveCliPlanModePrompt(opts, statErr == nil)
		if appendPrompt != "" {
			appendPrompt = planPrompt + "\n\n" + appendPrompt
		} else {
			appendPrompt = planPrompt
		}
	}
	if appendPrompt != "" {
		args = append(args, "--append-system-prompt", appendPrompt)
	}

	// Allowed tools: use the provided list, or a read-only default. This is
	// advisory under bypassPermissions (the real plan-mode boundary is
	// --disallowedTools above), but it keeps the non-plan defaults tight.
	allowedTools := opts.AllowedTools
	if len(allowedTools) == 0 {
		if opts.HookSettingsPath != "" {
			allowedTools = []string{"Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent", "TaskCreate", "TaskList", "TaskGet", "LSP", "NotebookEdit"}
		} else {
			allowedTools = []string{"Read", "Glob", "Grep", "LS", "Agent", "WebSearch", "WebFetch"}
		}
	}
	// When an MCP ToolServer is wired, add the wildcard allowlist entry so the
	// CLI offers every ion-extensions tool (including the plan-mode ExitPlanMode)
	// to the model.
	if opts.McpConfig != "" {
		allowedTools = append(allowedTools, "mcp__"+McpServerName+"__*")
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "added MCP wildcard to allowedTools: mcp____*", map[string]any{
			"mcp_server_name": McpServerName,
		})
	}
	args = append(args, "--allowedTools", strings.Join(allowedTools, ","))

	if opts.McpConfig != "" {
		args = append(args, "--mcp-config", opts.McpConfig)
	}
	if opts.HookSettingsPath != "" {
		args = append(args, "--settings", opts.HookSettingsPath)
	}
	return args
}
