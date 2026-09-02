package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// PollStarter registers an inference-driven poll with the owning session.
type PollStarter func(ctx context.Context, request PollRequest, cwd string) (string, error)

type pollStarterKey struct{}

// PollRequest is the validated model request that a session turns into a poll.
type PollRequest struct {
	Intent       string
	CheckCommand string
	Interval     time.Duration
	Deadline     time.Duration
	MaxAttempts  int
	Model        string
}

func WithPollStarter(ctx context.Context, fn PollStarter) context.Context {
	return context.WithValue(ctx, pollStarterKey{}, fn)
}

func pollStarterFromContext(ctx context.Context) PollStarter {
	fn, _ := ctx.Value(pollStarterKey{}).(PollStarter) //nolint:errcheck // absent outside session runs
	return fn
}

// PollTool starts a bounded, inference-driven background check. It is not a
// sleep: advancing results re-arm internally and only terminal results reach
// the parent orchestrator.
func PollTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Poll",
		Description: "Sparingly monitor external state that has no completion callback. A bounded child agent judges evidence as satisfied, failed, advancing, or uncertain; the engine retries only advancing work and delivers one terminal verdict. Poll costs one inference per attempt, so reserve it for work that needs judgment. Never use Poll to wait for Agent or dispatch completion — those results are delivered automatically. Never use Poll to wait for your own background Bash command either: start it with run_in_background and notify_on_complete and end your turn, which waits for free. The check command must directly observe the condition in intent. Do not sleep or manually re-poll while Poll is active.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"intent":        map[string]any{"type": "string", "description": "External condition to watch, what counts as satisfied or failed, and what evidence proves it"},
				"check_command": map[string]any{"type": "string", "description": "Optional shell command that directly observes the intent; the engine runs it before each inference attempt and uses its raw output as evidence. Its complete output is sent to the check agent, so a command that prints a lot costs a lot per attempt — print what the verdict needs, not everything available"},
				"interval_ms":   map[string]any{"type": "number", "description": "Delay between attempts in milliseconds; clamped to the configured floor"},
				"deadline_ms":   map[string]any{"type": "number", "description": "Whole-poll deadline in milliseconds; clamped to the configured ceiling"},
				"max_attempts":  map[string]any{"type": "number", "description": "Optional scope-down attempt cap; cannot exceed the configured ceiling"},
				"model":         map[string]any{"type": "string", "description": "Optional poll-child model override. Omit it: the engine already selects a fast tier. Judging evidence is mechanical work, so never name a premium or reasoning model here"},
			},
			"required": []string{"intent"},
		},
		Execute: executePoll,
	}
}

func executePoll(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	intent, _ := input["intent"].(string) //nolint:errcheck // schema validation is backend-dependent
	if intent == "" {
		return &types.ToolResult{Content: "Error: intent is required", IsError: true}, nil
	}
	starter := pollStarterFromContext(ctx)
	if starter == nil {
		return &types.ToolResult{Content: "Error: Poll is unavailable outside a session-owned engine run", IsError: true}, nil
	}
	request := PollRequest{
		Intent:       intent,
		CheckCommand: stringInput(input, "check_command"),
		Interval:     time.Duration(intFromInput(input, "interval_ms", 0)) * time.Millisecond,
		Deadline:     time.Duration(intFromInput(input, "deadline_ms", 0)) * time.Millisecond,
		MaxAttempts:  intFromInput(input, "max_attempts", 0),
		Model:        stringInput(input, "model"),
	}
	id, err := starter(ctx, request, cwd)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}
	return &types.ToolResult{
		Content:          fmt.Sprintf("Poll started: %s\nThe engine will retry only while external work is advancing and will deliver one terminal verdict with evidence. Do not sleep or re-poll. Agent and dispatch completion must use their automatic delivery instead.", id),
		BackgroundTaskID: id,
	}, nil
}

func stringInput(input map[string]any, key string) string {
	value, _ := input[key].(string) //nolint:errcheck // optional non-string is ignored
	return value
}
