package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BashTool returns a ToolDef that executes bash commands via the pluggable
// BashOperations backend.
func BashTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Bash",
		Description: "Execute a bash command and return its output.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command": map[string]any{"type": "string", "description": "The bash command to execute"},
				"timeout": map[string]any{"type": "number", "description": "Timeout in milliseconds (default: 120000). Ignored when run_in_background is true."},
				"run_in_background": map[string]any{"type": "boolean", "description": "Run the command in the background and return immediately with a task ID and an output file path. Poll with TaskGet (or Read the output file); terminate with TaskStop. Use for long-lived processes (watchers, dev servers) that would otherwise hit the foreground timeout."},
			},
			"required": []string{"command"},
		},
		Execute: executeBash,
	}
}

func executeBash(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	command, _ := input["command"].(string) //nolint:errcheck // best-effort; failure not actionable here
	if command == "" {
		return &types.ToolResult{Content: "Error: command is required", IsError: true}, nil
	}

	if background, _ := input["run_in_background"].(bool); background { //nolint:errcheck // absent/non-bool means foreground
		return executeBashBackground(ctx, command, cwd)
	}

	defaultMs := int64(120000)
	if t := types.TimeoutsFrom(ctx); t != nil && t.BashDefaultMs != 0 {
		defaultMs = t.BashDefaultMs
	}
	timeoutMs := intFromInput(input, "timeout", int(defaultMs))
	timeout := time.Duration(timeoutMs) * time.Millisecond

	ops := GetBashOperations()
	result, err := ops.Exec(ctx, command, cwd, ExecOptions{Timeout: timeout})
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	output := result.Stdout
	if result.Stderr != "" {
		output += "\nSTDERR:\n" + result.Stderr
	}

	if result.ExitCode != 0 {
		if output == "" {
			output = fmt.Sprintf("Command failed with exit code %d", result.ExitCode)
		}
		return &types.ToolResult{Content: output, IsError: true}, nil
	}

	if output == "" {
		output = "(no output)"
	}
	return &types.ToolResult{Content: output}, nil
}

// executeBashBackground handles run_in_background: true. The command starts
// detached from this tool call's context and is tracked in the tasks
// registry; the result names the task ID and output file so the model can
// poll or read output regardless of whether the Task tools are registered
// (they are harness opt-in — see optional.go).
func executeBashBackground(ctx context.Context, command, cwd string) (*types.ToolResult, error) {
	bg, ok := GetBashOperations().(BackgroundBashOperations)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "tools.bash", "run_in_background unsupported by configured backend", map[string]any{"count": len(command)})
		return &types.ToolResult{
			Content: "Error: run_in_background is not supported by the configured bash backend",
			IsError: true,
		}, nil
	}

	info, err := startBackgroundBashTask(ctx, bg, command, cwd, ExecOptions{})
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	content := fmt.Sprintf("Background task started: %s\nOutput file: %s", info.ID, info.OutputPath)
	if GetTool("TaskGet") != nil {
		content += "\nUse TaskGet to poll status and recent output, TaskStop to terminate."
	} else {
		content += "\nRead the output file to inspect progress."
	}
	return &types.ToolResult{Content: content}, nil
}
