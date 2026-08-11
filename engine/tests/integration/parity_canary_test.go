//go:build integration

// parity_canary_test.go — behavioural parity between the TypeScript and Go
// SDKs.
//
// Each scenario runs against both canary variants, captures what it observed
// into a comparable struct, and then a "cross" subtest asserts the two
// observations are equal. That last step is what makes this a parity suite
// rather than two test suites: two independently-passing implementations can
// diverge for a long time before anyone notices, and only a direct comparison
// catches it.
//
// The canaries are engine/extensions/parity-canary/index.ts and
// engine/extensions/go-canary/main.go, written to be behaviourally identical.
// A change to one without the other turns the cross subtest red.
//
// Loading the Go canary by directory also covers the executable-main entry
// resolution with a real compiled binary, as a side effect of running at all.

package integration

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// loadCanary loads one variant into a fresh host.
func loadParityCanary(t *testing.T, variant canaryVariant) *extension.Host {
	t.Helper()
	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	if err := host.Load(variant.LoadPath, &extension.ExtensionConfig{
		ExtensionDir:     variant.ExtDir,
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load %s canary from %s: %v", variant.Name, variant.LoadPath, err)
	}
	return host
}

// runParity runs observe against both variants and asserts the results are
// deep-equal. Each variant also gets its own subtest, so a failure says which
// side is wrong rather than only that they differ.
func runParity[T any](t *testing.T, observe func(t *testing.T, host *extension.Host) T) {
	t.Helper()
	variants := canaryVariants(t)

	results := make(map[string]T, len(variants))
	for _, variant := range variants {
		t.Run(variant.Name, func(t *testing.T) {
			host := loadParityCanary(t, variant)
			results[variant.Name] = observe(t, host)
		})
	}

	t.Run("cross", func(t *testing.T) {
		ts, okTS := results["typescript"]
		gо, okGo := results["go"]
		if !okTS || !okGo {
			t.Skip("one variant did not produce an observation; its own subtest reports why")
		}
		if !reflect.DeepEqual(ts, gо) {
			t.Errorf("the two SDKs behaved differently.\n  typescript: %+v\n  go:         %+v\n"+
				"The canaries are written to be identical; a difference here means one SDK "+
				"implements the protocol differently from the other.", ts, gо)
		}
	})
}

// --- Scenario: init handshake ---

type initObservation struct {
	Name      string
	Tools     []string
	Commands  []string
	Webhooks  []string
	Schedules []string
	Resources []string
}

// TestParity_InitHandshake pins that both SDKs declare the same registrations
// in the handshake. Everything the canaries register happens at module scope,
// so this also proves both take the pre-init queueing path rather than trying
// to send RPCs before the engine is listening.
func TestParity_InitHandshake(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) initObservation {
		if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
			t.Fatalf("committing async declarations: %v", errs)
		}

		obs := initObservation{Name: host.Name()}

		for _, tool := range host.Tools() {
			obs.Tools = append(obs.Tools, tool.Name)
		}
		for name := range host.Commands() {
			obs.Commands = append(obs.Commands, name)
		}
		for _, w := range host.Webhooks() {
			obs.Webhooks = append(obs.Webhooks, w.Path+" "+w.Method)
		}
		for _, s := range host.Schedules() {
			obs.Schedules = append(obs.Schedules, s.JobID+" "+string(s.Kind))
		}
		for _, r := range host.Resources() {
			obs.Resources = append(obs.Resources, r.Kind)
		}

		sort.Strings(obs.Tools)
		sort.Strings(obs.Commands)
		sort.Strings(obs.Webhooks)
		sort.Strings(obs.Schedules)
		sort.Strings(obs.Resources)

		// Sanity-check the observation itself: an empty one would compare
		// equal across variants and prove nothing.
		if obs.Name != "parity-canary" {
			t.Errorf("extension name = %q, want parity-canary", obs.Name)
		}
		if len(obs.Tools) != 2 {
			t.Errorf("tools = %v, want the two canary tools", obs.Tools)
		}
		if len(obs.Webhooks) != 1 || len(obs.Schedules) != 1 || len(obs.Resources) != 1 {
			t.Errorf("async/resource declarations = %v / %v / %v, want one of each",
				obs.Webhooks, obs.Schedules, obs.Resources)
		}

		return obs
	})
}

// --- Scenario: before_prompt rewrite ---

type promptObservation struct {
	Rewritten string
	SystemAdd string
}

// TestParity_BeforePromptRewrite pins the bare-string payload path. The engine
// wraps a non-object payload under _payload; an SDK that skipped the unwrap
// would hand the handler the envelope and the rewrite would come back wrong.
func TestParity_BeforePromptRewrite(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) promptObservation {
		ctx := &extension.Context{SessionKey: "parity-session"}
		prompt, systemAdd, err := host.SDK().FireBeforePrompt(ctx, "original prompt")
		if err != nil {
			t.Fatalf("firing before_prompt: %v", err)
		}
		if prompt != "original prompt [canary]" {
			t.Errorf("rewritten prompt = %q, want the canary suffix appended", prompt)
		}
		return promptObservation{Rewritten: prompt, SystemAdd: systemAdd}
	})
}

// --- Scenario: session identity through _ctx ---

type sessionKeyObservation struct {
	EchoedContent string
}

// TestParity_SessionKeyReachesTool pins that _ctx metadata is separated from
// the tool's arguments and reaches the handler as session identity. The echo
// tool returns both halves, so a mix-up shows up in the content.
func TestParity_SessionKeyReachesTool(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) sessionKeyObservation {
		tool := findTool(t, host, "canary_echo")
		ctx := &extension.Context{SessionKey: "sk-parity"}

		result, err := tool.Execute(map[string]any{"text": "hello"}, ctx)
		if err != nil {
			t.Fatalf("executing canary_echo: %v", err)
		}
		if result == nil || result.IsError {
			t.Fatalf("canary_echo reported failure: %+v", result)
		}
		if !strings.Contains(result.Content, "echo:hello") {
			t.Errorf("content = %q, want the echoed text", result.Content)
		}
		if !strings.Contains(result.Content, "session:sk-parity") {
			t.Errorf("content = %q, want the session key from _ctx", result.Content)
		}
		return sessionKeyObservation{EchoedContent: result.Content}
	})
}

// --- Scenario: tool_call veto ---

type toolCallObservation struct {
	Blocked bool
	Reason  string
	Allowed bool
}

// TestParity_ToolCallVeto pins the block-shaped hook result in both
// directions: a refusal carries its reason, and a non-refusal abstains rather
// than returning an empty veto that would read as an opinion.
func TestParity_ToolCallVeto(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) toolCallObservation {
		ctx := &extension.Context{SessionKey: "parity-session"}

		blocked, err := host.SDK().FireToolCall(ctx, extension.ToolCallInfo{
			ToolName: "__canary_blocked__", ToolID: "t1", Input: map[string]any{},
		})
		if err != nil {
			t.Fatalf("firing tool_call for the blocked tool: %v", err)
		}
		if blocked == nil || !blocked.Block {
			t.Fatalf("the canary did not block __canary_blocked__: %+v", blocked)
		}

		allowed, err := host.SDK().FireToolCall(ctx, extension.ToolCallInfo{
			ToolName: "Read", ToolID: "t2", Input: map[string]any{},
		})
		if err != nil {
			t.Fatalf("firing tool_call for an ordinary tool: %v", err)
		}
		isAllowed := allowed == nil || !allowed.Block

		return toolCallObservation{
			Blocked: blocked.Block,
			Reason:  blocked.Reason,
			Allowed: isAllowed,
		}
	})
}

// --- Scenario: event batching ---

type eventObservation struct {
	Types    []string
	Messages []string
}

// TestParity_EventBatching pins that an event emitted inside a hook arrives
// with that hook's response rather than as a separate notification, in both
// SDKs. The Go side reaches this through an explicit per-invocation buffer and
// the TypeScript side through a module global; the observable result must be
// identical.
func TestParity_EventBatching(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) eventObservation {
		var obs eventObservation
		ctx := &extension.Context{
			SessionKey: "parity-session",
			Emit: func(ev types.EngineEvent) {
				obs.Types = append(obs.Types, ev.Type)
				obs.Messages = append(obs.Messages, ev.EventMessage)
			},
		}

		if err := host.SDK().FireSessionStart(ctx); err != nil {
			t.Fatalf("firing session_start: %v", err)
		}

		if len(obs.Types) != 1 {
			t.Fatalf("emitted events = %v, want exactly one batched event", obs.Types)
		}
		if obs.Types[0] != "engine_harness_message" {
			t.Errorf("event type = %q, want engine_harness_message", obs.Types[0])
		}
		if obs.Messages[0] != "canary session start" {
			t.Errorf("event message = %q, want the canary's message", obs.Messages[0])
		}
		return obs
	})
}

// --- Scenario: webhook fire ---

type webhookObservation struct {
	Status int
	Body   string
}

// TestParity_WebhookFire pins the inbound fire path end to end: the engine
// dispatches to a route registered at init, the handler parses the body, and
// the response comes back in the shape the engine's HTTP layer writes out.
func TestParity_WebhookFire(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) webhookObservation {
		if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
			t.Fatalf("committing async declarations: %v", errs)
		}

		payload := map[string]any{
			"method":  "POST",
			"path":    "/canary/hello",
			"url":     "/canary/hello",
			"headers": map[string]string{"Content-Type": "application/json"},
			"body":    `{"name":"parity"}`,
			"remote":  "127.0.0.1:1234",
		}

		ctx := &extension.Context{SessionKey: "parity-session"}
		raw, err := host.FireAsync(asyncreg.KindWebhook, "/canary/hello", ctx, payload, 10*time.Second)
		if err != nil {
			t.Fatalf("firing the webhook: %v", err)
		}

		var resp struct {
			Status int    `json:"status"`
			Body   string `json:"body"`
		}
		if err := json.Unmarshal(raw, &resp); err != nil {
			t.Fatalf("decoding the webhook response: %v (raw=%s)", err, raw)
		}
		if resp.Status != 200 {
			t.Errorf("status = %d, want 200", resp.Status)
		}
		if !strings.Contains(resp.Body, `"greeted":"parity"`) {
			t.Errorf("body = %q, want the greeting built from the request body", resp.Body)
		}
		return webhookObservation{Status: resp.Status, Body: resp.Body}
	})
}

// --- Scenario: schedule fire ---

type scheduleObservation struct {
	Fired bool
}

// TestParity_ScheduleFire pins that a schedule registered at init is reachable
// through engine/fire_async and that its handler completes without error in
// both SDKs.
func TestParity_ScheduleFire(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) scheduleObservation {
		if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
			t.Fatalf("committing async declarations: %v", errs)
		}

		ctx := &extension.Context{SessionKey: "parity-session"}
		payload := map[string]any{"firedAt": "2026-01-01T00:00:00Z", "backfill": false}

		if _, err := host.FireAsync(asyncreg.KindSchedule, "canary-tick", ctx, payload, 10*time.Second); err != nil {
			t.Fatalf("firing the schedule: %v", err)
		}
		return scheduleObservation{Fired: true}
	})
}

// --- Scenario: resource query ---

type resourceObservation struct {
	IDs      []string
	Titles   []string
	Contents []string
}

// TestParity_ResourceQuery pins the subscription path. The engine stores
// nothing, so a client subscribing means the extension is asked for its own
// snapshot — and both SDKs must answer with the same items.
func TestParity_ResourceQuery(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) resourceObservation {
		items, err := host.CallResourceQuery("canary_note", types.ResourceFilter{Kind: "canary_note"})
		if err != nil {
			t.Fatalf("querying the canary_note resource: %v", err)
		}
		if len(items) != 1 {
			t.Fatalf("items = %+v, want the single canary note", items)
		}

		var obs resourceObservation
		for _, item := range items {
			obs.IDs = append(obs.IDs, item.ID)
			obs.Titles = append(obs.Titles, item.Title)
			obs.Contents = append(obs.Contents, item.Content)
		}
		return obs
	})
}

// --- Scenario: outbound call while serving an inbound one ---

type reentrancyObservation struct {
	Content string
}

// TestParity_CallToolReentrancy pins that a tool can call back into the engine
// while it is still executing. The TypeScript runtime gets this from its event
// loop; the Go SDK gets it from serving each inbound request on its own
// goroutine. An implementation that blocked its read loop would deadlock here
// rather than fail an assertion, so the timeout is the real signal.
func TestParity_CallToolReentrancy(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) reentrancyObservation {
		tool := findTool(t, host, "canary_call_tool")

		// The engine-side CallTool the extension reaches through
		// ext/call_tool. Answering it while the outer tool is still running
		// is the whole point of the scenario.
		ctx := &extension.Context{
			SessionKey: "parity-session",
			CallTool: func(name string, input map[string]any) (*types.ToolResult, error) {
				return &types.ToolResult{Content: "inner result for " + name}, nil
			},
		}

		done := make(chan *types.ToolResult, 1)
		errCh := make(chan error, 1)
		go func() {
			result, err := tool.Execute(map[string]any{"target": "some_engine_tool"}, ctx)
			if err != nil {
				errCh <- err
				return
			}
			done <- result
		}()

		select {
		case err := <-errCh:
			t.Fatalf("the nested tool call failed: %v", err)
		case result := <-done:
			if result == nil || result.IsError {
				t.Fatalf("canary_call_tool reported failure: %+v", result)
			}
			// The engine pretty-prints an extension tool's result object, so
			// the content is JSON wrapping the string rather than the bare
			// string. Assert on the substring the tool actually produced.
			want := "nested:inner result for some_engine_tool"
			if !strings.Contains(result.Content, want) {
				t.Errorf("content = %q, want it to contain %q", result.Content, want)
			}
			return reentrancyObservation{Content: result.Content}
		case <-time.After(20 * time.Second):
			t.Fatal("the nested tool call never completed: the SDK's read loop is blocked " +
				"on its own pending request")
		}
		// Unreachable: every arm above either returns or calls t.Fatal.
		return reentrancyObservation{}
	})
}

// --- Scenario: unknown-method degradation ---

type degradationObservation struct {
	Survived bool
}

// TestParity_UnknownMethodSurvival pins graceful degradation from the engine's
// side. The protocol has no version negotiation, so an engine calling a method
// an SDK does not implement must get a refusal and a still-usable connection —
// not a dead subprocess.
func TestParity_UnknownMethodSurvival(t *testing.T) {
	runParity(t, func(t *testing.T, host *extension.Host) degradationObservation {
		// A hook neither canary registers. Both must answer rather than
		// stalling, because the engine fires every hook at every extension.
		ctx := &extension.Context{SessionKey: "parity-session"}
		if err := host.SDK().FireTurnStart(ctx, extension.TurnInfo{TurnNumber: 1}); err != nil {
			t.Fatalf("firing an unhandled hook: %v", err)
		}

		// The connection must still work afterwards.
		tool := findTool(t, host, "canary_echo")
		result, err := tool.Execute(map[string]any{"text": "still alive"}, ctx)
		if err != nil {
			t.Fatalf("the extension stopped responding after an unhandled hook: %v", err)
		}
		if result == nil || !strings.Contains(result.Content, "still alive") {
			t.Fatalf("unexpected result after the unhandled hook: %+v", result)
		}
		return degradationObservation{Survived: true}
	})
}
