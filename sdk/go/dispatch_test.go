package ion

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// dispatch_test.go — envelope handling, event batching, and the init
// handshake.
//
// These pin the semantics an SDK cannot infer from the protocol shape alone:
// which key holds the payload, when events ride the response versus going out
// alone, and what the handshake must contain.

// TestHookPayloadUnwrapsPayloadKey pins the _payload convention. A bare string
// cannot be merged into the params object alongside _ctx, so the engine wraps
// it. An SDK that skipped the unwrap would hand a before_prompt handler
// {"_payload": "..."} instead of the prompt.
func TestHookPayloadUnwrapsPayloadKey(t *testing.T) {
	fe := newFakeEngine(t, WithName("unwrap-test"))

	got := make(chan string, 1)
	OnHook(fe.sdk, HookBeforePrompt, func(ctx *Context, prompt string) (BeforePromptResult, error) {
		got <- prompt
		return BeforePromptResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(10, "hook/"+HookNameBeforePrompt, map[string]any{
		payloadWrapperKey: "write me a haiku",
		ctxKey:            map[string]any{"sessionKey": "s1"},
	})
	fe.awaitResponse(10)

	select {
	case prompt := <-got:
		if prompt != "write me a haiku" {
			t.Errorf("handler received %q, want the unwrapped prompt", prompt)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler never ran")
	}
}

// TestHookPayloadStripsCtxKey pins that _ctx is metadata, not payload. Leaving
// it in would put a sessionKey field on every object payload, which decodes
// into nothing and misleads anyone reading a raw frame.
func TestHookPayloadStripsCtxKey(t *testing.T) {
	fe := newFakeEngine(t, WithName("ctx-strip-test"))

	got := make(chan TurnInfo, 1)
	gotCtx := make(chan *Context, 1)
	OnHook(fe.sdk, HookTurnStart, func(ctx *Context, info TurnInfo) (NoResult, error) {
		got <- info
		gotCtx <- ctx
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(11, "hook/"+HookNameTurnStart, map[string]any{
		"turnNumber": 7,
		ctxKey: map[string]any{
			"sessionKey":     "session-abc",
			"conversationId": "conv-xyz",
			"runId":          "run-123",
			"traceId":        "4bf92f3577b34da6a3ce929d0e0e4736",
			"depth":          2,
			"dispatchId":     "d-1",
			"model": map[string]any{
				"id":            "claude-x",
				"contextWindow": 200000,
			},
			"cwd": "/tmp/work",
		},
	})
	fe.awaitResponse(11)

	info := <-got
	if info.TurnNumber != 7 {
		t.Errorf("TurnNumber = %d, want 7", info.TurnNumber)
	}

	ctx := <-gotCtx
	if ctx.SessionKey != "session-abc" {
		t.Errorf("SessionKey = %q, want session-abc", ctx.SessionKey)
	}
	if ctx.ConversationID != "conv-xyz" {
		t.Errorf("ConversationID = %q, want conv-xyz", ctx.ConversationID)
	}
	if ctx.Depth != 2 {
		t.Errorf("Depth = %d, want 2", ctx.Depth)
	}
	if ctx.DispatchID != "d-1" {
		t.Errorf("DispatchID = %q, want d-1", ctx.DispatchID)
	}
	if ctx.RunID != "run-123" || ctx.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("run identity = %q / %q, want run-123 / trace ID", ctx.RunID, ctx.TraceID)
	}
	if ctx.Model == nil {
		t.Fatal("Model = nil, want claude-x")
	}
	if ctx.Model.ID != "claude-x" || ctx.Model.ContextWindow != 200000 {
		t.Errorf("Model = %+v, want claude-x / 200000", ctx.Model)
	}
	if ctx.Cwd != "/tmp/work" {
		t.Errorf("Cwd = %q, want /tmp/work", ctx.Cwd)
	}
}

// TestRootSessionCtxDefaults pins that the engine omitting depth and
// dispatchId is the root-session shape rather than missing data. An SDK that
// treated absence as an error, or invented a sentinel, would misreport every
// root firing.
func TestRootSessionCtxDefaults(t *testing.T) {
	fe := newFakeEngine(t, WithName("root-ctx-test"))

	gotCtx := make(chan *Context, 1)
	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		gotCtx <- ctx
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{WorkingDirectory: "/from/config"})

	fe.request(12, "hook/"+HookNameSessionStart, map[string]any{
		ctxKey: map[string]any{"sessionKey": "root"},
	})
	fe.awaitResponse(12)

	ctx := <-gotCtx
	if ctx.Depth != 0 || ctx.DispatchID != "" {
		t.Errorf("root context = depth %d / dispatchId %q, want 0 / empty", ctx.Depth, ctx.DispatchID)
	}
	if ctx.Cwd != "/from/config" {
		t.Errorf("Cwd = %q, want the init config's working directory", ctx.Cwd)
	}
}

// TestEmitInsideHookBatchesIntoResponse pins the batching half of the emit
// contract: events raised during a handler ride out with its return value, so
// the engine applies them atomically with the decision the handler made.
func TestEmitInsideHookBatchesIntoResponse(t *testing.T) {
	fe := newFakeEngine(t, WithName("emit-batch-test"))

	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "one"}))
		ctx.Emit(NewEvent("engine_harness_message", map[string]any{"message": "two"}))
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(20, "hook/"+HookNameSessionStart, map[string]any{})
	resp := fe.awaitResponse(20)

	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("result is not an object: %+v", resp)
	}
	events, ok := result["events"].([]any)
	if !ok {
		t.Fatalf("result has no events array: %+v", result)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
	first, _ := events[0].(map[string]any)
	if first["type"] != "engine_harness_message" || first["message"] != "one" {
		t.Errorf("first event = %+v, want the flattened harness message", first)
	}

	// No standalone ext/emit notification: batching means exactly one frame.
	for _, f := range fe.allFrames() {
		if f["method"] == "ext/emit" {
			t.Errorf("emit inside a hook also sent a standalone notification: %+v", f)
		}
	}
}

// TestEmitAfterHookSendsNotification pins the other half. A goroutine the
// handler spawned outlives the invocation, and its event cannot join a
// response that has already been written — so it must go out on its own rather
// than being silently dropped into a dead buffer.
func TestEmitAfterHookSendsNotification(t *testing.T) {
	fe := newFakeEngine(t, WithName("emit-after-test"))

	escaped := make(chan *Context, 1)
	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		escaped <- ctx
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(21, "hook/"+HookNameSessionStart, map[string]any{})
	fe.awaitResponse(21)

	// The invocation has answered and the buffer is sealed.
	ctx := <-escaped
	ctx.Emit(NewEvent("engine_notify", map[string]any{"message": "late", "level": "info"}))

	frame := fe.awaitMethod("ext/emit")
	params, ok := frame["params"].(map[string]any)
	if !ok {
		t.Fatalf("ext/emit has no params: %+v", frame)
	}
	if params["type"] != "engine_notify" || params["message"] != "late" {
		t.Errorf("emitted event = %+v, want the flattened notify event", params)
	}
}

// TestHookResultWithEventsWrapsScalar pins the wrapping rule for a scalar
// return. An object result gains an events key in place; a scalar cannot, so
// it is nested under value. The engine's forwarders accept both shapes, and
// getting this wrong silently discards either the value or the events.
func TestHookResultWithEventsWrapsScalar(t *testing.T) {
	fe := newFakeEngine(t, WithName("wrap-scalar-test"))

	OnHook(fe.sdk, HookInput, func(ctx *Context, input string) (StringResult, error) {
		ctx.Emit(NewEvent("engine_working_message", map[string]any{"message": "thinking"}))
		return StringResult("rewritten"), nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(22, "hook/"+HookNameInput, map[string]any{payloadWrapperKey: "original"})
	resp := fe.awaitResponse(22)

	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("result is not an object: %+v", resp)
	}
	if result["value"] != "rewritten" {
		t.Errorf("result.value = %v, want rewritten", result["value"])
	}
	if events, _ := result["events"].([]any); len(events) != 1 {
		t.Errorf("result.events = %v, want one event", result["events"])
	}
}

// TestHookResultObjectGainsEventsKey pins the object case: the result's own
// fields stay at the top level and events joins them, rather than the result
// being nested under value.
func TestHookResultObjectGainsEventsKey(t *testing.T) {
	fe := newFakeEngine(t, WithName("wrap-object-test"))

	OnHook(fe.sdk, HookBeforePrompt, func(ctx *Context, prompt string) (BeforePromptResult, error) {
		ctx.Emit(NewEvent("engine_working_message", map[string]any{"message": "rewriting"}))
		return BeforePromptResult{Prompt: "changed"}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(23, "hook/"+HookNameBeforePrompt, map[string]any{payloadWrapperKey: "original"})
	resp := fe.awaitResponse(23)

	result, _ := resp["result"].(map[string]any)
	if result["prompt"] != "changed" {
		t.Errorf("result.prompt = %v, want changed (fields must stay top level)", result["prompt"])
	}
	if events, _ := result["events"].([]any); len(events) != 1 {
		t.Errorf("result.events = %v, want one event", result["events"])
	}
}

// TestZeroResultAbstains pins that returning the zero result means "no
// opinion". The engine merges hook results last-writer-wins, so an SDK that
// sent an empty struct instead of null would have every registered handler
// overwrite the previous one's decision with nothing.
func TestZeroResultAbstains(t *testing.T) {
	fe := newFakeEngine(t, WithName("abstain-test"))

	OnHook(fe.sdk, HookBeforePrompt, func(ctx *Context, prompt string) (BeforePromptResult, error) {
		return BeforePromptResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(24, "hook/"+HookNameBeforePrompt, map[string]any{payloadWrapperKey: "x"})
	resp := fe.awaitResponse(24)

	if resp["result"] != nil {
		t.Errorf("result = %+v, want null so the engine reads it as an abstention", resp["result"])
	}
}

// TestUnregisteredHookAnswersNull pins that a hook nobody handles is answered,
// not ignored. The engine fires every hook at every extension; leaving one
// unanswered would stall its dispatch.
func TestUnregisteredHookAnswersNull(t *testing.T) {
	fe := newFakeEngine(t, WithName("no-handler-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(25, "hook/"+HookNameTurnEnd, map[string]any{"turnNumber": 1})
	resp := fe.awaitResponse(25)

	if resp["result"] != nil {
		t.Errorf("result = %+v, want null", resp["result"])
	}
	if resp["error"] != nil {
		t.Errorf("unhandled hook produced an error: %+v", resp["error"])
	}
}

// TestInitResultCarriesRegistrations pins the handshake contents against the
// field names the engine's parseInitResult decodes.
func TestInitResultCarriesRegistrations(t *testing.T) {
	fe := newFakeEngine(t, WithName("init-contents-test"))

	fe.sdk.RegisterTool(ToolDef{
		Name:        "beta_tool",
		Description: "second alphabetically",
		Parameters:  map[string]any{"type": "object"},
	})
	fe.sdk.RegisterTool(ToolDef{
		Name:         "alpha_tool",
		Description:  "first alphabetically",
		Parameters:   map[string]any{"type": "object"},
		PlanModeSafe: true,
	})
	fe.sdk.RegisterCommand("greet", CommandDef{Description: "say hello"})

	fe.start()
	result := fe.doInit(ExtensionConfig{ExtensionDir: "/ext", Model: "m", WorkingDirectory: "/w"})

	if result["name"] != "init-contents-test" {
		t.Errorf("name = %v, want the configured extension name", result["name"])
	}

	tools, ok := result["tools"].([]any)
	if !ok || len(tools) != 2 {
		t.Fatalf("tools = %+v, want 2", result["tools"])
	}
	// Sorted, so a respawn produces an identical handshake and engine-side
	// logs stay diffable.
	first, _ := tools[0].(map[string]any)
	if first["name"] != "alpha_tool" {
		t.Errorf("first tool = %v, want alpha_tool (init payload must be sorted)", first["name"])
	}
	if first["planModeSafe"] != true {
		t.Errorf("alpha_tool.planModeSafe = %v, want true", first["planModeSafe"])
	}
	second, _ := tools[1].(map[string]any)
	if second["planModeSafe"] != nil {
		t.Errorf("beta_tool.planModeSafe = %v, want it omitted when false", second["planModeSafe"])
	}

	commands, ok := result["commands"].(map[string]any)
	if !ok {
		t.Fatalf("commands = %+v, want an object", result["commands"])
	}
	greet, _ := commands["greet"].(map[string]any)
	if greet["description"] != "say hello" {
		t.Errorf("commands.greet.description = %v, want 'say hello'", greet["description"])
	}
}

func TestInitResultReportsBuildIdentity(t *testing.T) {
	oldIdentity := BuildIdentity
	BuildIdentity = "engine-v1.2.3-test"
	t.Cleanup(func() { BuildIdentity = oldIdentity })

	fe := newFakeEngine(t, WithName("build-identity-test"))
	fe.start()
	result := fe.doInit(ExtensionConfig{})
	if got := result["buildIdentity"]; got != "engine-v1.2.3-test" {
		t.Fatalf("buildIdentity = %v, want stamped identity", got)
	}
}

func TestInitResultOmitsEmptyBuildIdentity(t *testing.T) {
	oldIdentity := BuildIdentity
	BuildIdentity = ""
	t.Cleanup(func() { BuildIdentity = oldIdentity })

	fe := newFakeEngine(t, WithName("empty-build-identity-test"))
	fe.start()
	result := fe.doInit(ExtensionConfig{})
	if _, exists := result["buildIdentity"]; exists {
		t.Fatalf("buildIdentity = %v, want omitted when unstamped", result["buildIdentity"])
	}
}

// TestInitConfigReachesContext pins that the handshake config becomes the
// default for every later invocation, so a handler can read
// ctx.Config.ExtensionDir without the engine repeating it in each _ctx.
func TestInitConfigReachesContext(t *testing.T) {
	fe := newFakeEngine(t, WithName("init-config-test"))

	gotCtx := make(chan *Context, 1)
	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		gotCtx <- ctx
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{
		ExtensionDir:     "/ext/dir",
		Model:            "some-model",
		WorkingDirectory: "/work",
		McpConfigPath:    "/mcp.json",
	})

	fe.request(30, "hook/"+HookNameSessionStart, map[string]any{})
	fe.awaitResponse(30)

	ctx := <-gotCtx
	if ctx.Config.ExtensionDir != "/ext/dir" {
		t.Errorf("Config.ExtensionDir = %q, want /ext/dir", ctx.Config.ExtensionDir)
	}
	if ctx.Config.McpConfigPath != "/mcp.json" {
		t.Errorf("Config.McpConfigPath = %q, want /mcp.json", ctx.Config.McpConfigPath)
	}
}

// TestToolCallRoundTrip pins tool dispatch: the arguments arrive with _ctx
// stripped, and the result comes back in the shape the engine reads.
func TestToolCallRoundTrip(t *testing.T) {
	fe := newFakeEngine(t, WithName("tool-test"))

	fe.sdk.RegisterTool(ToolDef{
		Name:        "echo",
		Description: "echo the input",
		Parameters:  map[string]any{"type": "object"},
		Execute: func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) {
			var args struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(input, &args); err != nil {
				return ToolResult{}, err
			}
			if ctx.SessionKey != "tool-session" {
				return ToolResult{}, nil
			}
			return ToolResult{Content: "echo: " + args.Text}, nil
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(40, "tool/echo", map[string]any{
		"text": "hello",
		ctxKey: map[string]any{"sessionKey": "tool-session"},
	})
	resp := fe.awaitResponse(40)

	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("tool result is not an object: %+v", resp)
	}
	if result["content"] != "echo: hello" {
		t.Errorf("content = %v, want 'echo: hello'", result["content"])
	}
}

// TestToolErrorBecomesErrorResult pins that a tool's failure reaches the model
// as tool output rather than as an RPC error. The model can react to a failed
// tool; an RPC error is an extension malfunction and is not the same thing.
func TestToolErrorBecomesErrorResult(t *testing.T) {
	fe := newFakeEngine(t, WithName("tool-error-test"))

	fe.sdk.RegisterTool(ToolDef{
		Name:       "failing",
		Parameters: map[string]any{"type": "object"},
		Execute: func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) {
			return ToolResult{}, errTestToolFailed
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(41, "tool/failing", map[string]any{})
	resp := fe.awaitResponse(41)

	if resp["error"] != nil {
		t.Fatalf("tool failure produced an RPC error rather than an error result: %+v", resp["error"])
	}
	result, _ := resp["result"].(map[string]any)
	if result["isError"] != true {
		t.Errorf("result.isError = %v, want true", result["isError"])
	}
	if result["content"] != errTestToolFailed.Error() {
		t.Errorf("result.content = %v, want the error message", result["content"])
	}
}

// TestUnknownToolAnswers32601 pins that a call for a tool this extension does
// not have is refused explicitly, so the engine's pending call resolves.
func TestUnknownToolAnswers32601(t *testing.T) {
	fe := newFakeEngine(t, WithName("unknown-tool-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(42, "tool/nonexistent", map[string]any{})
	resp := fe.awaitResponse(42)

	errObj, ok := resp["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected an error response: %+v", resp)
	}
	if code, _ := errObj["code"].(float64); int(code) != CodeMethodNotFound {
		t.Errorf("code = %v, want %d", errObj["code"], CodeMethodNotFound)
	}
}

// TestCommandRoundTrip pins command dispatch: args arrive as a string and a
// successful command answers null.
func TestCommandRoundTrip(t *testing.T) {
	fe := newFakeEngine(t, WithName("command-test"))

	got := make(chan string, 1)
	fe.sdk.RegisterCommand("run", CommandDef{
		Description: "run something",
		Execute: func(c context.Context, ctx *Context, args string) error {
			got <- args
			return nil
		},
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(50, "command/run", map[string]any{"args": "--verbose now"})
	resp := fe.awaitResponse(50)

	if resp["error"] != nil {
		t.Fatalf("command produced an error: %+v", resp["error"])
	}
	if args := <-got; args != "--verbose now" {
		t.Errorf("args = %q, want '--verbose now'", args)
	}
}

// TestCallToolFromInsideHook pins outbound-while-inbound: a hook handler
// issuing its own RPC must complete, which only works because inbound requests
// run on their own goroutines.
func TestCallToolFromInsideHook(t *testing.T) {
	fe := newFakeEngine(t, WithName("nested-call-test"))

	toolResult := make(chan ToolResult, 1)
	OnHook(fe.sdk, HookSessionStart, func(ctx *Context, _ NoPayload) (NoResult, error) {
		res, err := ctx.CallTool(context.Background(), "Read", map[string]any{"path": "/tmp/x"})
		if err != nil {
			return NoResult{}, err
		}
		toolResult <- res
		return NoResult{}, nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(60, "hook/"+HookNameSessionStart, map[string]any{})

	callFrame := fe.awaitMethod("ext/call_tool")
	callID, _ := callFrame["id"].(float64)
	fe.respond(callID, map[string]any{"content": "file contents"})

	fe.awaitResponse(60)

	select {
	case res := <-toolResult:
		if res.Content != "file contents" {
			t.Errorf("tool content = %q, want 'file contents'", res.Content)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the nested tool call never completed")
	}
}

var errTestToolFailed = &testError{"tool blew up"}

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

// TestWorkspaceContextPayloadsReachHooks pins workspace facts across the
// JSON-RPC boundary for both hooks that receive them. Without these fields a
// public Go SDK handler sees an empty payload even though the engine supplied
// structured workspace context.
func TestWorkspaceContextPayloadsReachHooks(t *testing.T) {
	fe := newFakeEngine(t, WithName("workspace-context-test"))

	contextInject := make(chan ContextInjectInfo, 1)
	systemInject := make(chan SystemInjectInfo, 1)
	OnHook(fe.sdk, HookContextInject, func(_ *Context, info ContextInjectInfo) (StringResult, error) {
		contextInject <- info
		return "", nil
	})
	OnHook(fe.sdk, HookSystemInject, func(_ *Context, info SystemInjectInfo) (StringResult, error) {
		systemInject <- info
		return "", nil
	})

	fe.start()
	fe.doInit(ExtensionConfig{})

	workspace := map[string]any{
		"kind":   "bench",
		"cwd":    "/tmp/bench",
		"bench":  map[string]any{"title": "integration"},
		"client": map[string]any{"source": "desktop"},
	}
	fe.request(71, "hook/"+HookNameContextInject, map[string]any{
		"workingDirectory": "/tmp/bench",
		"discoveredPaths":  []string{"AGENTS.md"},
		"workspace":        workspace,
	})
	fe.awaitResponse(71)
	fe.request(72, "hook/"+HookNameSystemInject, map[string]any{
		"kind":        "workspace_context",
		"defaultText": "workspace facts",
		"workspace":   workspace,
	})
	fe.awaitResponse(72)

	assertWorkspace := func(name string, got *WorkspacePromptContext) {
		t.Helper()
		if got == nil {
			t.Fatalf("%s Workspace = nil", name)
		}
		if got.Kind != "bench" || got.Cwd != "/tmp/bench" {
			t.Errorf("%s Workspace identity = %#v", name, got)
		}
		if got.Bench["title"] != "integration" || got.Client["source"] != "desktop" {
			t.Errorf("%s Workspace maps = %#v", name, got)
		}
	}
	assertWorkspace("context_inject", (<-contextInject).Workspace)
	assertWorkspace("system_inject", (<-systemInject).Workspace)
}
