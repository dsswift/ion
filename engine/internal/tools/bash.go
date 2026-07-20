package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
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
				"timeout": map[string]any{"type": "number", "description": "Timeout in milliseconds (default: 120000)"},
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
