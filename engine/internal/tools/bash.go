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
				"notify_on_complete": map[string]any{"type": "boolean", "description": "Only meaningful with run_in_background. Deliver this command's result back to the session when it finishes, instead of requiring polling. You may start further work, start more background commands, or end your turn; the engine holds the session until the command completes and then delivers its exit code and output tail along with any other background commands still outstanding."},
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
		notify, _ := input["notify_on_complete"].(bool) //nolint:errcheck // absent/non-bool means no notification
		return executeBashBackground(ctx, command, cwd, notify)
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
//
// When notify is true the task is additionally registered on the owning
// session's outstanding set, which is what lets the engine hold the session
// open until the command finishes and deliver the result without polling.
func executeBashBackground(ctx context.Context, command, cwd string, notify bool) (*types.ToolResult, error) {
	bg, ok := GetBashOperations().(BackgroundBashOperations)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "tools.bash", "run_in_background unsupported by configured backend", map[string]any{"count": len(command)})
		return &types.ToolResult{
			Content: "Error: run_in_background is not supported by the configured bash backend",
			IsError: true,
		}, nil
	}

	// A notifying task needs an owning session to deliver to. Without one
	// (a bare tool invocation outside a session-owned run) the completion has
	// nowhere to go, so say so rather than silently starting a task whose
	// promised delivery never arrives.
	owner := BackgroundTaskOwnerFromContext(ctx)
	if notify && owner == "" {
		utils.LogWithFields(utils.LevelWarn, "tools.bash", "notify_on_complete requested with no owning session; starting without delivery", map[string]any{"count": len(command)})
		notify = false
	}

	info, err := startBackgroundBashTask(ctx, bg, command, cwd, ExecOptions{}, notify)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	if notify {
		if reg := OutstandingRegistrarFromContext(ctx); reg != nil {
			reg(info.ID, command)
			utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task added to session outstanding set", map[string]any{
				"task_id": info.ID, "session_id": owner,
			})
		} else {
			utils.LogWithFields(utils.LevelWarn, "tools.bash", "notify_on_complete task has no outstanding registrar; completion will notify but the session will not hold for it", map[string]any{
				"task_id": info.ID, "session_id": owner,
			})
		}
	}

	content := fmt.Sprintf("Background task started: %s\nOutput file: %s", info.ID, info.OutputPath)
	if notify {
		content += "\nCompletion will be delivered to this session when the command finishes — do not poll for it. You may continue working, start more background commands, or end your turn."
	} else if GetTool("TaskGet") != nil {
		content += "\nUse TaskGet to poll status and recent output, TaskStop to terminate."
	} else {
		content += "\nRead the output file to inspect progress."
	}
	return &types.ToolResult{Content: content}, nil
}
