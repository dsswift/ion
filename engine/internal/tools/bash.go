package tools

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BashTool returns a ToolDef that executes bash commands via the pluggable
// BashOperations backend.
func BashTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Bash",
		Description: "Execute a bash command and return its output. Bare sleep commands at or above the configured threshold are refused in foreground and background modes. For a real command, use run_in_background with notify_on_complete; use Poll only for inference-driven wait-and-recheck work, never to watch a command you started here.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"command":            map[string]any{"type": "string", "description": "The bash command to execute"},
				"timeout":            map[string]any{"type": "number", "description": "Timeout in milliseconds (default: 120000). Values above the engine's configured maximum are clamped. Ignored when run_in_background is true."},
				"run_in_background":  map[string]any{"type": "boolean", "description": "Run the command in the background and return immediately with a task ID and output file path. Set notify_on_complete with it unless you truly never need the result. Read the output file for progress; TaskGet and TaskStop are available only when the harness registered the Task tools. Use for real long-lived commands, not bare sleep."},
				"notify_on_complete": map[string]any{"type": "boolean", "description": "Only meaningful with run_in_background. Deliver this command's result back to the session when it finishes, instead of requiring polling. This is the cheapest way to wait: it costs no inference, unlike Poll. You may start further work or start more background commands. When this task is the only remaining work, end your turn; the engine parks the session and resumes it when the command completes."},
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

	// Refuse bare long sleeps in every execution mode. A background shell does
	// not block this tool call, but it produces no useful work; a notifying one
	// additionally holds the session and injects a wake turn. Poll owns real
	// wait-and-recheck loops without creating shell noise.
	timeouts := types.TimeoutsFrom(ctx)
	if threshold, gateOn := timeouts.BashBlockingSleep(); gateOn {
		if secs, blocked := detectBlockingSleep(command, threshold); blocked {
			utils.LogWithFields(utils.LevelInfo, "tools.bash", "bare sleep refused", map[string]any{
				"sleep_seconds": secs, "threshold_ms": threshold.Milliseconds(), "background": input["run_in_background"] == true, "count": len(command), "cwd": cwd,
			})
			return &types.ToolResult{Content: blockingSleepMessage(secs, threshold, input["run_in_background"] == true, GetTool("TaskGet") != nil), IsError: true}, nil
		}
	}

	if background, _ := input["run_in_background"].(bool); background { //nolint:errcheck // absent/non-bool means foreground
		notify, _ := input["notify_on_complete"].(bool) //nolint:errcheck // absent/non-bool means no notification
		return executeBashBackground(ctx, command, cwd, notify)
	}

	// Foreground only past this point. The leading-sleep gate above has already
	// handled every execution mode.

	defaultMs := int64(120000)
	if timeouts != nil && timeouts.BashDefaultMs != 0 {
		defaultMs = timeouts.BashDefaultMs
	}
	timeoutMs := intFromInput(input, "timeout", int(defaultMs))
	timeout := time.Duration(timeoutMs) * time.Millisecond

	// Clamp the requested timeout to the configured ceiling. The clamp is
	// reported on the tool result (below) rather than silently applied: a
	// model that asked for 90 minutes and got 10 needs to know which number
	// actually governed the call.
	clampNotice := ""
	if maxTimeout, capOn := timeouts.BashMax(); capOn && timeout > maxTimeout {
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "requested timeout clamped to configured maximum", map[string]any{
			"requested_ms": timeout.Milliseconds(),
			"max_ms":       maxTimeout.Milliseconds(),
			"count":        len(command),
		})
		clampNotice = fmt.Sprintf(
			"NOTE: the requested timeout of %dms exceeds the maximum of %dms and was clamped. "+
				"To wait longer than that, start the command with run_in_background: true and notify_on_complete: true.\n\n",
			timeout.Milliseconds(), maxTimeout.Milliseconds())
		timeout = maxTimeout
	}

	ops := GetBashOperations()
	result, err := ops.Exec(ctx, command, cwd, ExecOptions{
		Timeout: timeout,
		Env:     bashExecutionEnv(ctx),
	})

	// A timed-out command reports the deadline it hit and the mechanism that
	// outlives it. This precedes the error check because a killed process
	// reaches here BOTH ways depending on the backend: the local backend's
	// wait yields an *exec.ExitError (exit code -1, nil Go error, the raw
	// result would read "Command failed with exit code -1"), while another
	// backend may surface the kill as a Go error ("signal: killed"). Neither
	// raw form names the timeout or the alternative.
	if result != nil && result.TimedOut {
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "command exceeded its timeout", map[string]any{
			"timeout_ms": timeout.Milliseconds(),
			"exit_code":  result.ExitCode,
			"count":      len(command),
		})
		content := clampNotice + fmt.Sprintf(
			"Error: the command was killed after exceeding its %dms timeout. "+
				"To run work that takes longer, start it with run_in_background: true and notify_on_complete: true — "+
				"the result is delivered to this session when it finishes.",
			timeout.Milliseconds())
		// Preserve whatever the command managed to emit before the kill; it
		// is often the most useful part of a timed-out run.
		if partial := strings.TrimSpace(result.Stdout + "\n" + result.Stderr); partial != "" {
			content += "\n\nPartial output before the kill:\n" + partial
		}
		return &types.ToolResult{Content: content, IsError: true}, nil
	}

	if err != nil {
		return &types.ToolResult{Content: clampNotice + fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	output := result.Stdout
	if result.Stderr != "" {
		output += "\nSTDERR:\n" + result.Stderr
	}

	if result.ExitCode != 0 {
		if output == "" {
			output = fmt.Sprintf("Command failed with exit code %d", result.ExitCode)
		}
		return &types.ToolResult{Content: clampNotice + output, IsError: true}, nil
	}

	if output == "" {
		output = "(no output)"
	}
	return &types.ToolResult{Content: clampNotice + output}, nil
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

	info, err := startBackgroundBashTask(ctx, bg, command, cwd, ExecOptions{
		Env: bashExecutionEnv(ctx),
	}, notify)
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
		content += "\nCompletion will be delivered to this session when the command finishes — do not poll for it. You may continue with other useful work or start more background commands. If this task is the only remaining work, end your turn; the engine parks the session and resumes it on completion."
	} else if GetTool("TaskGet") != nil {
		content += "\nUse TaskGet to poll status and recent output, TaskStop to terminate."
	} else {
		content += "\nRead the output file to inspect progress."
	}
	return &types.ToolResult{Content: content, BackgroundTaskID: info.ID}, nil
}
