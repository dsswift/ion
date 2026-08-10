package ion

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// context_emit_test.go — where an emitted event goes, per invocation kind.
//
// Emit has two destinations and the choice is not stylistic: only a hook
// response carries an events array, so only a hook can batch. A tool, command,
// webhook, or schedule handler has nowhere to put a batched event, and an SDK
// that buffered one there would drop it silently — the handler would look
// correct, the engine would simply never see the event.
//
// This mirrors the TypeScript runtime, which sets its activeEvents global only
// around a hook invocation (runtime.ts), leaving every other handler to emit
// immediately.

// awaitEmit waits for an ext/emit notification, failing with a message that
// names the drop rather than just timing out.
func awaitEmit(t *testing.T, fe *fakeEngine, from string) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		for _, f := range fe.allFrames() {
			if f["method"] == "ext/emit" {
				return f
			}
		}
		select {
		case <-deadline:
			t.Fatalf("an Emit from %s never reached the engine: it was buffered "+
				"into a response that has no events array, so nothing ever sent it", from)
			return nil
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
}

// TestEmitFromToolSendsNotification pins that a tool's Emit reaches the engine.
func TestEmitFromToolSendsNotification(t *testing.T) {
	fe := newFakeEngine(t, WithName("tool-emit-test"))

	fe.sdk.RegisterTool(ToolDef{
		Name:       "emitter",
		Parameters: map[string]any{"type": "object"},
		Execute: func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) {
			ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "from tool"}))
			return ToolResult{Content: "ok"}, nil
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.request(900, "tool/emitter", map[string]any{})
	fe.awaitResponse(900)

	frame := awaitEmit(t, fe, "a tool")
	params, _ := frame["params"].(map[string]any)
	if params["message"] != "from tool" {
		t.Errorf("emitted event = %+v, want the tool's message", params)
	}
}

// TestEmitFromCommandSendsNotification pins the same for a slash command.
func TestEmitFromCommandSendsNotification(t *testing.T) {
	fe := newFakeEngine(t, WithName("command-emit-test"))

	fe.sdk.RegisterCommand("go", CommandDef{
		Description: "emit something",
		Execute: func(c context.Context, ctx *Context, args string) error {
			ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "from command"}))
			return nil
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.request(901, "command/go", map[string]any{"args": ""})
	fe.awaitResponse(901)

	frame := awaitEmit(t, fe, "a command")
	params, _ := frame["params"].(map[string]any)
	if params["message"] != "from command" {
		t.Errorf("emitted event = %+v, want the command's message", params)
	}
}

// TestEmitFromWebhookSendsNotification pins the async path. A webhook handler
// runs outside any hook, so its Emit has no response to ride.
func TestEmitFromWebhookSendsNotification(t *testing.T) {
	fe := newFakeEngine(t, WithName("webhook-emit-test"))

	_, err := fe.sdk.Webhooks().Register(context.Background(),
		WebhookRoute{Path: "/emit", Auth: WebhookAuth{Kind: AuthNone}},
		func(c context.Context, ctx *Context, req WebhookRequest) (WebhookResponse, error) {
			ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "from webhook"}))
			return WebhookResponse{Status: 200}, nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.request(902, methodFireAsync, map[string]any{
		"kind": "webhook", "id": "/emit", "payload": map[string]any{"method": "POST"},
	})
	fe.awaitResponse(902)

	frame := awaitEmit(t, fe, "a webhook handler")
	params, _ := frame["params"].(map[string]any)
	if params["message"] != "from webhook" {
		t.Errorf("emitted event = %+v, want the webhook's message", params)
	}
}

// TestEmitFromScheduleSendsNotification pins the schedule half of the async
// path.
func TestEmitFromScheduleSendsNotification(t *testing.T) {
	fe := newFakeEngine(t, WithName("schedule-emit-test"))

	_, err := fe.sdk.Schedule().Interval(context.Background(),
		ScheduleOpts{ID: "ticker", IntervalMs: 60000},
		func(c context.Context, ctx *Context, control ScheduleControl, meta ScheduleFireMeta) error {
			ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "from schedule"}))
			return nil
		})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.request(903, methodFireAsync, map[string]any{
		"kind": "schedule", "id": "ticker", "payload": map[string]any{},
	})
	fe.awaitResponse(903)

	frame := awaitEmit(t, fe, "a schedule handler")
	params, _ := frame["params"].(map[string]any)
	if params["message"] != "from schedule" {
		t.Errorf("emitted event = %+v, want the schedule's message", params)
	}
}

// TestEmitOnHookErrorPathIsFlushed pins that a handler which emits and then
// fails does not lose the events. The error response has no events array, so
// anything already buffered has to be flushed as notifications rather than
// discarded with the batch.
func TestEmitOnHookErrorPathIsFlushed(t *testing.T) {
	fe := newFakeEngine(t, WithName("hook-error-emit-test"))

	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "before the failure"}))
		return NoResult{}, errTestToolFailed
	})

	fe.start()
	fe.doInit(ExtensionConfig{})
	fe.request(904, "hook/"+HookNameSessionStart, map[string]any{})

	resp := fe.awaitResponse(904)
	if resp["error"] == nil {
		t.Fatalf("expected an error response, got %+v", resp)
	}

	frame := awaitEmit(t, fe, "a hook that then returned an error")
	params, _ := frame["params"].(map[string]any)
	if params["message"] != "before the failure" {
		t.Errorf("emitted event = %+v, want the pre-failure message", params)
	}
}

// TestEmitBatchingIsHookOnly states the invariant in one place: a hook's Emit
// rides its response and produces no notification, while every other
// invocation kind notifies and adds nothing to a response.
func TestEmitBatchingIsHookOnly(t *testing.T) {
	fe := newFakeEngine(t, WithName("batching-scope-test"))

	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "hook"}))
		return NoResult{}, nil
	})
	fe.sdk.RegisterTool(ToolDef{
		Name:       "t",
		Parameters: map[string]any{"type": "object"},
		Execute: func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) {
			ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "tool"}))
			return ToolResult{Content: "ok"}, nil
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	// Hook: batched into the response, no notification.
	fe.request(905, "hook/"+HookNameSessionStart, map[string]any{})
	hookResp := fe.awaitResponse(905)
	result, ok := hookResp["result"].(map[string]any)
	if !ok {
		t.Fatalf("hook result is not an object: %+v", hookResp)
	}
	if events, _ := result["events"].([]any); len(events) != 1 {
		t.Errorf("hook response events = %v, want exactly one batched event", result["events"])
	}
	for _, f := range fe.allFrames() {
		if f["method"] == "ext/emit" {
			t.Errorf("a hook's Emit also produced a standalone notification: %+v", f)
		}
	}

	// Tool: notified, and its result gains no events key.
	fe.request(906, "tool/t", map[string]any{})
	toolResp := fe.awaitResponse(906)
	toolResult, _ := toolResp["result"].(map[string]any)
	if _, hasEvents := toolResult["events"]; hasEvents {
		t.Errorf("a tool result carried an events key: %+v", toolResult)
	}
	awaitEmit(t, fe, "a tool")
}
