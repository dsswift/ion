package extcontext

import (
	"fmt"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// newConvEventsCollector returns an enabled, sink-less telemetry.Collector so
// Event() buffers in memory without touching disk — mirrors
// internal/telemetry/conversation_emitter_test.go's newBufferingCollector,
// duplicated here (rather than exported) because internal/telemetry
// deliberately keeps its test helpers unexported.
func newConvEventsCollector(t *testing.T) *telemetry.Collector {
	t.Helper()
	return telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
}

func bufferedConvEvents(c *telemetry.Collector, name string) []telemetry.Event {
	var out []telemetry.Event
	for _, ev := range c.BufferedEvents() {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

// convEventsTestAccessor is a minimal SessionAccessor for exercising the
// conversation.* dispatch wiring end to end. It embeds noopSA for every
// method the dispatch path does not need to observe, and overrides only what
// this test cares about: a stable session key, the mock child backend, and a
// REAL (buffering) ConversationEventsTelemetry collector so emitted events
// can be inspected.
type convEventsTestAccessor struct {
	noopSA
	child     backend.RunBackend
	collector *telemetry.Collector
}

func (a *convEventsTestAccessor) SessionKey() string { return "conv-events-session" }
func (a *convEventsTestAccessor) NewChildBackend() backend.RunBackend {
	return a.child
}
func (a *convEventsTestAccessor) ConversationEventsTelemetry() *telemetry.Collector {
	return a.collector
}

// convEventsChildBackend is a mock child backend that captures the RunConfig
// passed via StartRunWithConfig (specifically OnCallCost, the seam
// backend.go already exposes for exact per-turn cost delivery) and then
// drives a scripted event sequence mirroring the real runloop.go ordering:
// SessionInitEvent, UserTurnPersistedEvent, a tool call/result pair,
// OnCallCost + the paired UsageEvent that closes the assistant message, then
// TaskCompleteEvent and exit.
type convEventsChildBackend struct {
	mu       sync.Mutex
	onNorm   func(runID string, event types.NormalizedEvent)
	onExit   func(runID string, code *int, signal *string, sessionID string)
	onCost   func(model string, cost *telemetry.CallCost)
	convID   string
	toolID   string
	toolName string
	asstCost *telemetry.CallCost
	asstEID  string
	userEID  string
}

func (d *convEventsChildBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	d.mu.Lock()
	d.onNorm = fn
	d.mu.Unlock()
}
func (d *convEventsChildBackend) OnExit(fn func(string, *int, *string, string)) {
	d.mu.Lock()
	d.onExit = fn
	d.mu.Unlock()
}
func (d *convEventsChildBackend) OnError(func(string, error))            {}
func (d *convEventsChildBackend) Cancel(string) bool                     { return false }
func (d *convEventsChildBackend) IsRunning(string) bool                  { return false }
func (d *convEventsChildBackend) WriteToStdin(string, interface{}) error { return nil }
func (d *convEventsChildBackend) FlushConversations()                    {}
func (d *convEventsChildBackend) Capabilities() backend.BackendCapabilities {
	return backend.BackendCapabilities{Kind: "mock", ContextModel: backend.ContextModelEngineOwned}
}

// StartRunWithConfig captures cfg.OnCallCost — this is what makes the mock
// backend a "configurableBackend" per startChild's interface assertion
// (dispatch_child_setup.go), so BuildDispatchAgentFunc routes through this
// method instead of the plain StartRun.
func (d *convEventsChildBackend) StartRunWithConfig(requestID string, _ types.RunOptions, cfg *backend.RunConfig) {
	d.mu.Lock()
	if cfg != nil {
		d.onCost = cfg.OnCallCost
	}
	onNorm, onExit, onCost := d.onNorm, d.onExit, d.onCost
	d.mu.Unlock()

	go func() {
		emit := func(data types.NormalizedEventData) {
			if onNorm != nil {
				onNorm(requestID, types.NormalizedEvent{Data: data})
			}
		}
		// 1. Session init — carries the child's own conversation id.
		emit(&types.SessionInitEvent{SessionID: d.convID})
		// 2. The run-opening user turn is durably persisted.
		emit(&types.UserTurnPersistedEvent{EntryID: d.userEID})
		// 3. A tool call and its terminal result.
		emit(&types.ToolCallEvent{ToolName: d.toolName, ToolID: d.toolID})
		emit(&types.ToolResultEvent{ToolID: d.toolID, Content: "tool output", IsError: false})
		// 4. The completed assistant message: OnCallCost fires first (mirrors
		// runloop.go's ordering — see backend.go's OnCallCost doc comment),
		// then the paired UsageEvent carrying the same turn's EntryID.
		if onCost != nil {
			onCost("claude-sonnet-5", d.asstCost)
		}
		in := d.asstCost.InputTokens
		out := d.asstCost.OutputTokens
		emit(&types.UsageEvent{
			Usage:   types.UsageData{InputTokens: &in, OutputTokens: &out},
			EntryID: d.asstEID,
		})
		// 5. Completion.
		emit(&types.TaskCompleteEvent{Result: "done", SessionID: d.convID, CostUsd: d.asstCost.CostUsd})
		if onExit != nil {
			zero := 0
			onExit(requestID, &zero, nil, d.convID)
		}
	}()
}

// StartRun is required by backend.RunBackend but unused: startChild always
// prefers StartRunWithConfig once it detects the configurableBackend
// interface (dispatch_child_setup.go), and BuildDispatchAgentFunc always
// builds a non-nil childCfg for a dispatch (DefaultModel threading alone
// guarantees it — see dispatch_agent.go).
func (d *convEventsChildBackend) StartRun(requestID string, opts types.RunOptions) {
	d.StartRunWithConfig(requestID, opts, nil)
}

// TestDispatchConversationEvents_FullSequence is the child 05 integration
// test: a dispatched child's accepted user turn, completed assistant turn,
// and terminal tool result each produce the corresponding conversation.*
// event, every one carrying a non-empty dispatch_id (the child path ALWAYS
// populates it — frozen contract, see ConversationEmitter's doc comment) and
// the CHILD's own conversation_id (never the parent session's, which this
// test accessor deliberately leaves empty via noopSA.ConversationID).
//
// Also pins requirement 2 from the child 05 spec: the assistant_message
// event's cost values match EXACTLY what backend.RunConfig.OnCallCost
// delivered — proving the dispatch adapter reuses the existing accumulated
// value rather than recomputing it.
func TestDispatchConversationEvents_FullSequence(t *testing.T) {
	const childConvID = "child-conv-full-seq"
	collector := newConvEventsCollector(t)

	cost := &telemetry.CallCost{
		InputTokens:              321,
		OutputTokens:             77,
		CacheReadInputTokens:     12,
		CacheCreationInputTokens: 3,
		CostUsd:                  0.0456,
	}
	child := &convEventsChildBackend{
		convID:   childConvID,
		toolID:   "tool-abc",
		toolName: "Bash",
		asstCost: cost,
		asstEID:  "asst-entry-1",
		userEID:  "user-entry-1",
	}
	acc := &convEventsTestAccessor{child: child, collector: collector}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	result, err := dispatchFn(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "conv-events-agent",
		Task:              "do the thing",
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}
	if result.DispatchID == "" {
		t.Fatal("dispatch returned empty DispatchID")
	}
	dispatchID := result.DispatchID

	// --- conversation.lifecycle: created (fresh child conversation) ---
	lifecycles := bufferedConvEvents(collector, telemetry.ConversationLifecycle)
	if len(lifecycles) == 0 {
		t.Fatal("no conversation.lifecycle event emitted")
	}
	lc := lifecycles[0]
	if lc.Payload["conversation_id"] != childConvID {
		t.Errorf("lifecycle conversation_id = %v, want %q", lc.Payload["conversation_id"], childConvID)
	}
	if lc.Payload["action"] != "created" {
		t.Errorf("lifecycle action = %v, want \"created\" (no opts.SessionID was supplied)", lc.Payload["action"])
	}
	if got, _ := lc.Payload["dispatch_id"].(string); got == "" {
		t.Error("lifecycle dispatch_id is empty, want non-empty (dispatch path always populates it)")
	} else if got != dispatchID {
		t.Errorf("lifecycle dispatch_id = %q, want %q", got, dispatchID)
	}

	// --- conversation.user_message ---
	userMsgs := bufferedConvEvents(collector, telemetry.ConversationUserMessage)
	if len(userMsgs) != 1 {
		t.Fatalf("got %d conversation.user_message events, want 1", len(userMsgs))
	}
	um := userMsgs[0]
	if um.Payload["conversation_id"] != childConvID {
		t.Errorf("user_message conversation_id = %v, want %q", um.Payload["conversation_id"], childConvID)
	}
	if um.Payload["entry_id"] != "user-entry-1" {
		t.Errorf("user_message entry_id = %v, want %q", um.Payload["entry_id"], "user-entry-1")
	}
	if got, _ := um.Payload["dispatch_id"].(string); got != dispatchID {
		t.Errorf("user_message dispatch_id = %q, want %q (non-empty, child's own)", got, dispatchID)
	}
	if got, _ := um.Payload["run_id"].(string); got == "" {
		t.Error("user_message run_id is empty, want the child's own run id")
	}

	// --- conversation.assistant_message: cost matches EXACTLY ---
	asstMsgs := bufferedConvEvents(collector, telemetry.ConversationAssistantMessage)
	if len(asstMsgs) != 1 {
		t.Fatalf("got %d conversation.assistant_message events, want 1", len(asstMsgs))
	}
	am := asstMsgs[0]
	if am.Payload["conversation_id"] != childConvID {
		t.Errorf("assistant_message conversation_id = %v, want %q", am.Payload["conversation_id"], childConvID)
	}
	if am.Payload["entry_id"] != "asst-entry-1" {
		t.Errorf("assistant_message entry_id = %v, want %q", am.Payload["entry_id"], "asst-entry-1")
	}
	if got, _ := am.Payload["dispatch_id"].(string); got != dispatchID {
		t.Errorf("assistant_message dispatch_id = %q, want %q", got, dispatchID)
	}
	gotCost, ok := am.Payload["cost"].(map[string]any)
	if !ok {
		t.Fatalf("assistant_message cost is not a map: %T %v", am.Payload["cost"], am.Payload["cost"])
	}
	wantCost := map[string]any{
		"input_tokens":                cost.InputTokens,
		"output_tokens":               cost.OutputTokens,
		"cache_read_input_tokens":     cost.CacheReadInputTokens,
		"cache_creation_input_tokens": cost.CacheCreationInputTokens,
		"cost_usd":                    cost.CostUsd,
	}
	for k, want := range wantCost {
		if gotCost[k] != want {
			t.Errorf("assistant_message cost[%q] = %v, want %v (must match the accumulator's own tracked value exactly)", k, gotCost[k], want)
		}
	}
	if am.Payload["model"] != "claude-sonnet-5" {
		t.Errorf("assistant_message model = %v, want %q (the model OnCallCost delivered)", am.Payload["model"], "claude-sonnet-5")
	}

	// --- conversation.tool_call: terminal result ---
	toolCalls := bufferedConvEvents(collector, telemetry.ConversationToolCall)
	if len(toolCalls) != 1 {
		t.Fatalf("got %d conversation.tool_call events, want 1", len(toolCalls))
	}
	tc := toolCalls[0]
	if tc.Payload["conversation_id"] != childConvID {
		t.Errorf("tool_call conversation_id = %v, want %q", tc.Payload["conversation_id"], childConvID)
	}
	if tc.Payload["tool_use_id"] != "tool-abc" {
		t.Errorf("tool_call tool_use_id = %v, want %q", tc.Payload["tool_use_id"], "tool-abc")
	}
	if tc.Payload["tool_name"] != "Bash" {
		t.Errorf("tool_call tool_name = %v, want %q", tc.Payload["tool_name"], "Bash")
	}
	if tc.Payload["outcome"] != telemetry.OutcomeSuccess {
		t.Errorf("tool_call outcome = %v, want %q", tc.Payload["outcome"], telemetry.OutcomeSuccess)
	}
	if got, _ := tc.Payload["dispatch_id"].(string); got != dispatchID {
		t.Errorf("tool_call dispatch_id = %q, want %q", got, dispatchID)
	}

	// --- Every conversation.* event's conversation_id is the CHILD's own,
	// never the (empty, in this test) parent session's ConversationID(). ---
	for _, name := range []string{
		telemetry.ConversationLifecycle,
		telemetry.ConversationUserMessage,
		telemetry.ConversationAssistantMessage,
		telemetry.ConversationToolCall,
	} {
		for _, ev := range bufferedConvEvents(collector, name) {
			if ev.Payload["conversation_id"] == "" || ev.Payload["conversation_id"] == acc.ConversationID() {
				t.Errorf("%s: conversation_id = %v, want the child's own conversation id %q (never the parent session's)", name, ev.Payload["conversation_id"], childConvID)
			}
		}
	}
}

// TestDispatchConversationEvents_RootChildPayloadParity pins requirement 3
// from the child 05 spec: a root-shaped call and a dispatch-shaped call
// through the SAME ConversationEmitter (the "one core, two adapters" design)
// produce payloads whose field sets and non-identity values are identical —
// they differ only in dispatch_id (root omits it entirely; the dispatch path
// always populates it) and conversation_id (each side's own).
//
// This directly exercises the live dispatch adapter (via
// TestDispatchConversationEvents_FullSequence's captured event) against a
// manually-issued "root style" call using the SAME emitter, the SAME
// tool_use_id/tool_name/run_id/outcome — proving the dispatch adapter did not
// drift from the emitter's documented, root-shared field contract. It is not
// a comparison against child 04's own root-path integration (a different,
// concurrently-developed change not present in this tree); it pins the
// emitter-level invariant child 04 and child 05 both depend on.
func TestDispatchConversationEvents_RootChildPayloadParity(t *testing.T) {
	const childConvID = "child-conv-parity"
	collector := newConvEventsCollector(t)

	cost := &telemetry.CallCost{InputTokens: 10, OutputTokens: 5, CostUsd: 0.001}
	child := &convEventsChildBackend{
		convID:   childConvID,
		toolID:   "tool-parity",
		toolName: "Read",
		asstCost: cost,
		asstEID:  "asst-parity",
		userEID:  "user-parity",
	}
	acc := &convEventsTestAccessor{child: child, collector: collector}

	dispatchFn := BuildDispatchAgentFunc(acc, nil, 0, "")
	result, err := dispatchFn(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "parity-agent",
		Task:              "read a file",
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}

	toolCalls := bufferedConvEvents(collector, telemetry.ConversationToolCall)
	if len(toolCalls) != 1 {
		t.Fatalf("got %d conversation.tool_call events, want 1", len(toolCalls))
	}
	childEvent := toolCalls[0]
	childRunID, _ := childEvent.Payload["run_id"].(string)
	if childRunID == "" {
		t.Fatal("child tool_call run_id is empty")
	}

	// Manually issue a root-shaped call through the SAME emitter/collector,
	// reusing every non-identity field from the child call (tool_use_id,
	// tool_name, run_id, outcome) but a root-style empty dispatch_id and the
	// root's own conversation_id.
	emitter := telemetry.NewConversationEmitter(collector)
	const rootConvID = "root-conv-parity"
	emitter.ToolCall(nil, rootConvID, "", "tool-parity", "Read", childRunID, "", telemetry.OutcomeSuccess, nil, "tool output")

	toolCalls = bufferedConvEvents(collector, telemetry.ConversationToolCall)
	if len(toolCalls) != 2 {
		t.Fatalf("got %d conversation.tool_call events after the manual root call, want 2", len(toolCalls))
	}
	rootEvent := toolCalls[1]

	// Field SETS: the root payload's keys must be a subset of the child
	// payload's keys, and the only key present in the child payload but
	// absent from the root payload must be dispatch_id.
	for k := range rootEvent.Payload {
		if _, ok := childEvent.Payload[k]; !ok {
			t.Errorf("root payload has key %q that the child payload lacks — the two adapters diverged on field set", k)
		}
	}
	var extraChildKeys []string
	for k := range childEvent.Payload {
		if _, ok := rootEvent.Payload[k]; !ok {
			extraChildKeys = append(extraChildKeys, k)
		}
	}
	if len(extraChildKeys) != 1 || extraChildKeys[0] != "dispatch_id" {
		t.Fatalf("child payload's keys beyond the root payload = %v, want exactly [\"dispatch_id\"]", extraChildKeys)
	}

	// Non-identity fields: every key other than conversation_id/dispatch_id
	// must carry the IDENTICAL value on both sides. seq is per conversation
	// by contract, so it is compared for presence rather than value: the
	// child's counter has advanced past its earlier events, the root's is
	// fresh.
	for _, ev := range []telemetry.Event{childEvent, rootEvent} {
		if seq, _ := ev.Payload["seq"].(int64); seq < 1 {
			t.Errorf("payload[\"seq\"] = %v on %q, want a positive per-conversation sequence", ev.Payload["seq"], ev.Payload["conversation_id"])
		}
	}
	for k, childVal := range childEvent.Payload {
		if k == "conversation_id" || k == "dispatch_id" || k == "seq" {
			continue
		}
		if rootVal := rootEvent.Payload[k]; rootVal != childVal {
			t.Errorf("payload[%q]: child=%v root=%v, want identical (adapters must only differ in dispatch_id/conversation_id)", k, childVal, rootVal)
		}
	}

	// Identity fields differ as expected.
	if childEvent.Payload["conversation_id"] != childConvID {
		t.Errorf("child conversation_id = %v, want %q", childEvent.Payload["conversation_id"], childConvID)
	}
	if rootEvent.Payload["conversation_id"] != rootConvID {
		t.Errorf("root conversation_id = %v, want %q", rootEvent.Payload["conversation_id"], rootConvID)
	}
	if got, _ := childEvent.Payload["dispatch_id"].(string); got == "" || got != result.DispatchID {
		t.Errorf("child dispatch_id = %q, want %q (non-empty)", got, result.DispatchID)
	}
	if _, ok := rootEvent.Payload["dispatch_id"]; ok {
		t.Errorf("root dispatch_id present as %v, want omitted (root path passes an empty dispatch_id)", rootEvent.Payload["dispatch_id"])
	}
}

// TestResolveDispatchConvExisted covers the pure created-vs-resumed
// classification helper directly, since driving an on-disk "resumed" case
// through the full dispatch integration would require fabricating a real
// conversation file. Empty conversationID (no opts.SessionID supplied, the
// common case — a brand-new dispatch) is always "created"; a non-empty id
// defers to conversation.Exists, exercised here via a nonexistent id (which
// conversation.Exists resolves to false without touching disk for a
// well-formed miss).
func TestResolveDispatchConvExisted(t *testing.T) {
	if got := resolveDispatchConvExisted(""); got {
		t.Errorf("resolveDispatchConvExisted(\"\") = true, want false (no opts.SessionID means a brand-new conversation)")
	}
	if got := resolveDispatchConvExisted(fmt.Sprintf("nonexistent-%d", 12345)); got {
		t.Error("resolveDispatchConvExisted on a nonexistent id = true, want false")
	}
	if action := dispatchLifecycleAction(false); action != telemetry.ActionCreated {
		t.Errorf("dispatchLifecycleAction(false) = %v, want ActionCreated", action)
	}
	if action := dispatchLifecycleAction(true); action != telemetry.ActionResumed {
		t.Errorf("dispatchLifecycleAction(true) = %v, want ActionResumed", action)
	}
}

// appCtxAccessor is a SessionAccessor whose AppContext reports a fixed map,
// for pinning that a dispatched child stamps its PARENT's surface identity.
type appCtxAccessor struct {
	noopSA
	appCtx map[string]string
}

func (a *appCtxAccessor) AppContext() map[string]string { return a.appCtx }

// TestDispatchAppCtx_CarriesParentSurface pins that a dispatched child's
// conversation.* events carry the parent session's app_context — a sub-agent
// runs inside the parent's surface and has none of its own, so an enterprise
// consumer can still attribute the child's tool calls to a tab.
func TestDispatchAppCtx_CarriesParentSurface(t *testing.T) {
	sa := &appCtxAccessor{appCtx: map[string]string{"tab": "tab-7", "sub_tab": "instance-2"}}

	ctx := dispatchAppCtx(sa)
	if ctx == nil {
		t.Fatal("dispatchAppCtx returned nil for a parent that has app context")
	}
	appCtx, ok := ctx["app_context"].(map[string]any)
	if !ok {
		t.Fatalf("app_context missing or wrong type: %#v", ctx)
	}
	if appCtx["tab"] != "tab-7" || appCtx["sub_tab"] != "instance-2" {
		t.Errorf("app_context = %#v, want tab-7 / instance-2", appCtx)
	}
}

// TestDispatchAppCtx_NilWhenUnset pins the default: no client-supplied
// context means the child emits the same nil context it emitted before this
// field existed.
func TestDispatchAppCtx_NilWhenUnset(t *testing.T) {
	if ctx := dispatchAppCtx(&appCtxAccessor{}); ctx != nil {
		t.Errorf("dispatchAppCtx = %#v, want nil when the parent has no app context", ctx)
	}
}
