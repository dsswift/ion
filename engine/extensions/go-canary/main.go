// go-canary -- the Go half of the dual-canary parity suite.
//
// Behaviourally identical to engine/extensions/parity-canary/index.ts: same
// name, same tools, same hooks, same webhook and schedule declarations, same
// emitted events, same startup log. The parity suite
// (engine/tests/integration/parity_canary_test.go) runs each scenario against
// both and asserts the two produce the *same* observations, not merely that
// each passes on its own.
//
// It is also the in-repo proof of the consumption shape: a nested go.mod with
// a replace directive pointing at sdk/go, built to a binary named main, loaded
// by directory. That is exactly what an external extension author does, minus
// the replace.
//
// Any change here needs the same change in parity-canary/index.ts, or the
// cross subtest fails — which is the mechanism working.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	ion "github.com/dsswift/ion/sdk/go"
)

func main() {
	sdk := ion.New(ion.WithName("parity-canary"))

	registerTools(sdk)
	registerCommands(sdk)
	registerHooks(sdk)
	registerAsync(sdk)
	registerResources(sdk)

	// Startup log. The parity suite reads it to confirm the log notification
	// path works identically from both SDKs.
	sdk.Log().Info("canary started", map[string]any{"language": "go"})

	if err := sdk.Run(); err != nil {
		// Nothing has a working protocol channel at this point, so stderr is
		// the only place left. The engine drains it into its own log.
		fmt.Fprintf(os.Stderr, "go-canary: serve loop failed: %v\n", err)
		os.Exit(1)
	}
}

func registerTools(sdk *ion.SDK) {
	// Echoes its input back. Proves the tool round trip and the _ctx split:
	// the session key comes from the envelope, the text from the arguments.
	sdk.RegisterTool(ion.ToolDef{
		Name:        "canary_echo",
		Description: "Echo the input text back",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"text": map[string]any{"type": "string"},
			},
			"required": []string{"text"},
		},
		Execute: func(c context.Context, ctx *ion.Context, input json.RawMessage) (ion.ToolResult, error) {
			var args struct {
				Text string `json:"text"`
			}
			if len(input) > 0 {
				if err := json.Unmarshal(input, &args); err != nil {
					return ion.ToolResult{}, fmt.Errorf("decode text argument: %w", err)
				}
			}
			return ion.ToolResult{
				Content: "echo:" + args.Text + ":session:" + ctx.SessionKey,
			}, nil
		},
	})

	// Calls another tool through the engine while this one is still
	// executing. Proves outbound-while-serving-inbound: a transport that
	// blocked its read loop on its own pending call would hang here.
	sdk.RegisterTool(ion.ToolDef{
		Name:        "canary_call_tool",
		Description: "Call another tool from inside a tool",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"target": map[string]any{"type": "string"},
			},
			"required": []string{"target"},
		},
		Execute: func(c context.Context, ctx *ion.Context, input json.RawMessage) (ion.ToolResult, error) {
			var args struct {
				Target string `json:"target"`
			}
			if len(input) > 0 {
				if err := json.Unmarshal(input, &args); err != nil {
					return ion.ToolResult{}, fmt.Errorf("decode target argument: %w", err)
				}
			}
			result, err := ctx.CallTool(c, args.Target, nil)
			if err != nil {
				return ion.ToolResult{}, err
			}
			return ion.ToolResult{Content: "nested:" + result.Content}, nil
		},
	})
}

func registerCommands(sdk *ion.SDK) {
	sdk.RegisterCommand("canary", ion.CommandDef{
		Description: "Canary command",
		Execute: func(c context.Context, ctx *ion.Context, args string) error {
			ctx.Log().Info("canary command invoked", map[string]any{
				"args": args, "sessionKey": ctx.SessionKey,
			})
			return nil
		},
	})
}

func registerHooks(sdk *ion.SDK) {
	// Emits during a hook, so the response carries a batched events array
	// rather than a standalone ext/emit notification.
	ion.OnHook(sdk, ion.HookSessionStart,
		func(ctx *ion.Context, _ ion.NoPayload) (ion.NoResult, error) {
			ctx.Emit(ion.NewEvent("engine_harness_message", map[string]any{
				"message": "canary session start",
			}))
			return ion.NoResult{}, nil
		})

	// Rewrites the prompt. The payload arrives as a bare string, so this also
	// exercises the _payload unwrap.
	ion.OnHook(sdk, ion.HookBeforePrompt,
		func(ctx *ion.Context, prompt string) (ion.BeforePromptResult, error) {
			return ion.BeforePromptResult{Prompt: prompt + " [canary]"}, nil
		})

	// Returns a typed veto result without blocking, exercising the
	// block-shaped return path.
	ion.OnHook(sdk, ion.HookToolCall,
		func(ctx *ion.Context, info ion.ToolCallInfo) (ion.ToolCallResult, error) {
			if info.ToolName == "__canary_blocked__" {
				return ion.ToolCallResult{Block: true, Reason: "canary refuses this tool"}, nil
			}
			return ion.ToolCallResult{}, nil
		})
}

func registerAsync(sdk *ion.SDK) {
	c := context.Background()

	// Declared before Run, so both must ride the init handshake rather than
	// going out as post-init RPCs.
	_, err := sdk.Webhooks().Register(c,
		ion.WebhookRoute{
			Path:   "/canary/hello",
			Method: "POST",
			Auth:   ion.WebhookAuth{Kind: ion.AuthNone},
		},
		func(c context.Context, ctx *ion.Context, req ion.WebhookRequest) (ion.WebhookResponse, error) {
			var parsed struct {
				Name string `json:"name"`
			}
			if err := req.JSON(&parsed); err != nil {
				return ion.WebhookResponse{}, err
			}
			if parsed.Name == "" {
				parsed.Name = "world"
			}
			body, err := json.Marshal(map[string]string{"greeted": parsed.Name})
			if err != nil {
				return ion.WebhookResponse{}, err
			}
			return ion.WebhookResponse{Status: 200, Body: string(body)}, nil
		})
	if err != nil {
		sdk.Log().Error("canary webhook registration failed", map[string]any{"error": err.Error()})
	}

	_, err = sdk.Schedule().Interval(c,
		ion.ScheduleOpts{ID: "canary-tick", IntervalMs: 60000},
		func(c context.Context, ctx *ion.Context, control ion.ScheduleControl, meta ion.ScheduleFireMeta) error {
			ctx.Log().Info("canary tick", nil)
			return nil
		})
	if err != nil {
		sdk.Log().Error("canary schedule registration failed", map[string]any{"error": err.Error()})
	}
}

func registerResources(sdk *ion.SDK) {
	if _, err := sdk.Resources().Declare(context.Background(), "canary_note"); err != nil {
		sdk.Log().Error("canary resource declaration failed", map[string]any{"error": err.Error()})
	}

	sdk.Resources().OnQuery("canary_note",
		func(c context.Context, filter ion.ResourceFilter) ([]ion.ResourceItem, error) {
			return []ion.ResourceItem{{
				ID:        "note-1",
				Kind:      "canary_note",
				Title:     "Canary note",
				Content:   "from the canary",
				CreatedAt: "2026-01-01T00:00:00Z",
			}}, nil
		})
}
