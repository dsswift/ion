package backend

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cli_child_rail.go — what a dispatched agent served by a delegated CLI needs
// beyond its tools: the permission rail, and plan mode.
//
// A root claude-code run gets both from the session layer. A dispatched child
// is wired here, from its own RunConfig and RunOptions, because it has no
// session of its own: its plan state is the plan mode it was dispatched with,
// and its permission rules are the ones its RunConfig carries from the session
// that dispatched it.
//
// Without this a claude-code child ran under bypassPermissions with no
// PreToolUse hook at all, so no permission rule, no async-mode refusal, and no
// plan-mode boundary reached it.

// childPlanPolicySource returns the plan policy for a dispatched child. A
// child's plan mode is fixed by its dispatch, so the answer does not change
// during the run.
func childPlanPolicySource(cfg *RunConfig, opts *types.RunOptions) PlanPolicySource {
	allowed := opts.PlanModeTools
	if len(allowed) == 0 {
		allowed = DefaultPlanModeTools()
	}
	external := cfg.ExternalTools
	clientTools := opts.ClientTools
	policy := PlanPolicy{
		AllowedTools:  allowed,
		BashAllowlist: effectiveBashAllowlist(*opts),
		McpAllowlist:  effectiveMcpAllowlist(*opts),
		PlanFilePath:  opts.PlanFilePath,
		Cwd:           opts.ProjectPath,
		PlanSafe: func(name string) bool {
			for _, td := range external {
				if td.Name == name {
					return td.PlanModeSafe
				}
			}
			for _, ct := range clientTools {
				if ct.Name == name {
					return ct.PlanModeSafe || ct.HumanWait
				}
			}
			return false
		},
	}
	planning := opts.PlanMode
	return func() (PlanPolicy, bool) { return policy, planning }
}

// wireChildPermissionRail starts the PreToolUse hook server for a claude-code
// child, writes the settings file that points the CLI at it, and ties both to
// the child's ToolServer so they are released when the server stops.
//
// A returned error means the child has no rail. The caller must not start it:
// the CLI runs under bypassPermissions, and a child without a rail would
// execute every tool call unchecked.
func wireChildPermissionRail(ts *ToolServer, sessionID string, cfg *RunConfig, opts *types.RunOptions, policy PlanPolicySource) error {
	hookServer, err := NewPermissionHookServer(cfg.PermEngine)
	if err != nil {
		return fmt.Errorf("permission rail: start hook server: %w", err)
	}
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		hookServer.Close()
		return fmt.Errorf("permission rail: generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)
	hookServer.RegisterToken(token)
	hookServer.SetTimeouts(cfg.Timeouts)
	hookServer.SetOnAsk(cfg.PermissionAsk)
	hookServer.SetPlanPolicySource(policy)

	settingsPath := filepath.Join(os.TempDir(), fmt.Sprintf("ion-settings-%s.json", token))
	if err := os.WriteFile(settingsPath, hookServer.GenerateSettingsJSON(token), 0600); err != nil {
		hookServer.Close()
		return fmt.Errorf("permission rail: write hook settings: %w", err)
	}
	opts.HookSettingsPath = settingsPath
	ts.OnStop(func() {
		hookServer.Close()
		if err := os.Remove(settingsPath); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, "backend.cli_child_tools", "failed to remove child hook settings file", map[string]any{"path": settingsPath, "error": err.Error()})
		}
	})
	utils.LogWithFields(utils.LevelInfo, "backend.cli_child_tools", "permission rail wired for delegated-CLI child", map[string]any{
		"session_id": sessionID, "port": hookServer.Port(), "has_perm_engine": cfg.PermEngine != nil, "has_ask": cfg.PermissionAsk != nil, "plan_mode": opts.PlanMode,
	})
	return nil
}

// registerChildPlanTools registers the plan tools on a claude-code child's
// ToolServer: ExitPlanMode and the WritePlan/EditPlan pair. They are registered
// whether or not the child was dispatched in plan mode, so the tools a child
// registers do not depend on its mode; outside plan mode each says so.
//
// The plan file is the path the dispatch allocated. emit carries
// PlanFileWrittenEvent to the child's event stream, the same signal an
// API-served child produces when it writes its plan file.
func registerChildPlanTools(ts *ToolServer, runID string, opts *types.RunOptions, emit func(string, types.NormalizedEvent)) {
	planning := opts.PlanMode
	planFilePath := opts.PlanFilePath
	notPlanning := func(tool string) *types.ToolResult {
		return &types.ToolResult{
			Content: fmt.Sprintf("%s is unavailable: you are not in plan mode.", tool),
			IsError: true,
		}
	}

	exitName, exitDesc, exitSchema := CliExitPlanModeTool()
	ts.RegisterTool(exitName, func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		utils.LogWithFields(utils.LevelInfo, "backend.cli_child_tools", "ExitPlanMode invoked by delegated-CLI child", map[string]any{"run_id": runID, "planning": planning})
		if !planning {
			return &types.ToolResult{Content: "Plan mode is not active, so there is no plan to present. Continue with the task."}, nil
		}
		return &types.ToolResult{Content: "Plan presented for approval. Planning is complete — take no further action and call no more tools."}, nil
	}, exitDesc, exitSchema)

	persist := func(tool, content string) (*types.ToolResult, error) {
		result, err := CapturePlanFileWrite(runID, content, planFilePath, emit)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "backend.cli_child_tools", "child plan file write failed", map[string]any{"run_id": runID, "tool": tool, "plan_file_path": planFilePath, "error": err.Error()})
			return &types.ToolResult{Content: fmt.Sprintf("Writing the plan file failed: %s. The plan was not saved.", err.Error()), IsError: true}, nil
		}
		utils.LogWithFields(utils.LevelInfo, "backend.cli_child_tools", "child plan file written", map[string]any{"run_id": runID, "tool": tool, "plan_file_path": planFilePath, "operation": result.Operation, "bytes": result.BytesWritten})
		return &types.ToolResult{Content: fmt.Sprintf("Plan file %s (%d bytes). Continue planning, revise with EditPlan, or call ExitPlanMode when the plan is ready — ExitPlanMode does not need the plan text, it reads this file.", result.Operation, result.BytesWritten)}, nil
	}

	writeName, writeDesc, writeSchema := CliWritePlanTool()
	ts.RegisterTool(writeName, func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		if !planning || planFilePath == "" {
			return notPlanning(writeName), nil
		}
		content, _ := input["content"].(string) //nolint:errcheck // empty/absent content handled by the guard below
		if content == "" {
			return &types.ToolResult{Content: "WritePlan requires non-empty `content`. Pass the full plan markdown, or use EditPlan to change part of an existing plan.", IsError: true}, nil
		}
		return persist(writeName, content)
	}, writeDesc, writeSchema)

	editName, editDesc, editSchema := CliEditPlanTool()
	ts.RegisterTool(editName, func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		if !planning || planFilePath == "" {
			return notPlanning(editName), nil
		}
		oldString, _ := input["old_string"].(string) //nolint:errcheck // empty anchor handled by ApplyPlanFileEdit
		newString, _ := input["new_string"].(string) //nolint:errcheck // empty replacement is a legal deletion
		content, matches, err := ApplyPlanFileEdit(planFilePath, oldString, newString)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.cli_child_tools", "child plan edit refused", map[string]any{"run_id": runID, "matches": matches, "error": err.Error()})
			return &types.ToolResult{Content: fmt.Sprintf("EditPlan failed: %s (matches: %d). Correct `old_string` so it appears exactly once, or use WritePlan to replace the whole plan.", err.Error(), matches), IsError: true}, nil
		}
		return persist(editName, content)
	}, editDesc, editSchema)
}

// childPlanNotice returns the prompt a claude-code child is started with: the
// plan-mode enter notice in front of the task when the child was dispatched in
// plan mode, the task unchanged otherwise. The spawn arguments carry no plan
// text, so this is how the child learns the rules.
func childPlanNotice(opts *types.RunOptions) string {
	if !opts.PlanMode {
		return opts.Prompt
	}
	return "<system-reminder>\n" + CliPlanModeEnterNotice(*opts, opts.PlanFilePath) + "\n</system-reminder>\n\n" + opts.Prompt
}

// childEmitter returns the event emitter of the concrete backend serving a
// claude-code child, or a no-op when the route is something else.
func childEmitter(route RunBackend) func(string, types.NormalizedEvent) {
	if cc, ok := route.(*ClaudeCodeBackend); ok {
		return cc.emit
	}
	return func(string, types.NormalizedEvent) {}
}
