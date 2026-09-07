package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// newConvEventsTestManager builds a minimal Manager with one session
// installed, wired to a buffering (sink-less) conversation-events collector
// so emitted events can be inspected directly — mirrors
// extcontext.newConvEventsCollector (dispatch_conversation_events_test.go),
// the child 05 sibling of this test file.
func newConvEventsTestManager(t *testing.T, s *engineSession) (*Manager, *telemetry.Collector) {
	t.Helper()
	m := &Manager{sessions: make(map[string]*engineSession)}
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	m.SetConversationEventsTelemetry(collector)
	m.sessions[s.key] = s
	return m, collector
}

func bufferedRootConvEvents(c *telemetry.Collector, name string) []telemetry.Event {
	var out []telemetry.Event
	for _, ev := range c.BufferedEvents() {
		if ev.Name == name {
			out = append(out, ev)
		}
	}
	return out
}

func newConvEventsTestSession(key, conversationID string) *engineSession {
	return &engineSession{key: key, conversationID: conversationID}
}

// TestEmitConversationEvents_NoConversationID_NoEmit pins the guard in
// emitConversationEvents: a session with no durable conversation identity yet
// (SessionInitEvent has not landed) must never emit a conversation.* event,
// since every payload requires a real conversation_id.
func TestEmitConversationEvents_NoConversationID_NoEmit(t *testing.T) {
	s := newConvEventsTestSession("k1", "")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{EntryID: "entry-1"}})

	if got := len(collector.BufferedEvents()); got != 0 {
		t.Fatalf("got %d buffered events, want 0 (no conversation_id)", got)
	}
}

// TestEmitConversationEvents_UserMessage pins that an accepted, persisted
// user turn (a real EntryID) produces exactly one conversation.user_message
// carrying that entry id.
func TestEmitConversationEvents_UserMessage(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{EntryID: "entry-1"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationUserMessage)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.user_message events, want 1", len(events))
	}
	ev := events[0]
	if ev.Payload["conversation_id"] != "conv-1" {
		t.Errorf("conversation_id = %v, want %q", ev.Payload["conversation_id"], "conv-1")
	}
	if ev.Payload["entry_id"] != "entry-1" {
		t.Errorf("entry_id = %v, want %q", ev.Payload["entry_id"], "entry-1")
	}
	if _, ok := ev.Payload["dispatch_id"]; ok {
		t.Errorf("dispatch_id present as %v, want omitted on the root path", ev.Payload["dispatch_id"])
	}
}

// TestEmitConversationEvents_UserMessage_EmptyEntryIDSkipped pins that a
// UserTurnPersistedEvent with no entry id (a rejected/queued-not-started
// prompt never reaches this shape with a real id) emits nothing.
func TestEmitConversationEvents_UserMessage_EmptyEntryIDSkipped(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{EntryID: ""}})

	if got := len(bufferedRootConvEvents(collector, telemetry.ConversationUserMessage)); got != 0 {
		t.Fatalf("got %d conversation.user_message events, want 0 (empty entry id)", got)
	}
}

// TestEmitConversationEvents_AssistantMessage_ApiBackendCost pins the
// ApiBackend/Hybrid path: a terminal UsageEvent carrying a real EntryID
// produces one conversation.assistant_message whose cost object matches
// EXACTLY what RunConfig.OnCallCost delivered via s.convCostTracker — proving
// the wiring reuses the tracked value rather than re-deriving it.
func TestEmitConversationEvents_AssistantMessage_ApiBackendCost(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	tracker := &sessionCostTracker{}
	cost := &telemetry.CallCost{InputTokens: 100, OutputTokens: 42, CostUsd: 0.0123}
	tracker.record("claude-sonnet-5", cost)
	s.convCostTracker = tracker
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UsageEvent{EntryID: "asst-1"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationAssistantMessage)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.assistant_message events, want 1", len(events))
	}
	ev := events[0]
	if ev.Payload["entry_id"] != "asst-1" {
		t.Errorf("entry_id = %v, want %q", ev.Payload["entry_id"], "asst-1")
	}
	if ev.Payload["model"] != "claude-sonnet-5" {
		t.Errorf("model = %v, want %q", ev.Payload["model"], "claude-sonnet-5")
	}
	gotCost, ok := ev.Payload["cost"].(map[string]any)
	if !ok {
		t.Fatalf("cost is not a map: %T %v", ev.Payload["cost"], ev.Payload["cost"])
	}
	if gotCost["input_tokens"] != cost.InputTokens || gotCost["output_tokens"] != cost.OutputTokens || gotCost["cost_usd"] != cost.CostUsd {
		t.Errorf("cost = %v, want it to match the tracked CallCost exactly (%+v)", gotCost, cost)
	}

	// take() clears the tracker; a second UsageEvent with no preceding
	// OnCallCost call must not replay the stale value.
	if model, c := tracker.take(); model != "" || c != nil {
		t.Errorf("tracker.take() after emit = (%q, %v), want cleared", model, c)
	}
}

// TestEmitConversationEvents_AssistantMessage_MidStreamUsageIgnored pins that
// a mid-stream UsageEvent with no EntryID and a non-codex backend kind (Claude
// Code's early/mid-stream cache-token progress, see normalizer.go) is NOT a
// completion signal and produces zero conversation.assistant_message events.
func TestEmitConversationEvents_AssistantMessage_MidStreamUsageIgnored(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	s.runCaps = backend.BackendCapabilities{Kind: "claude-code"}
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UsageEvent{EntryID: ""}})

	if got := len(bufferedRootConvEvents(collector, telemetry.ConversationAssistantMessage)); got != 0 {
		t.Fatalf("got %d conversation.assistant_message events, want 0 (mid-stream, no completion signal)", got)
	}
}

// TestEmitConversationEvents_AssistantMessage_Codex pins codex's own
// assistant-complete signal: a UsageEvent with no EntryID but runCaps.Kind ==
// "codex" DOES fire, with cost derived by codexUsageCallCost (CostUsd always
// 0 — codex is subscription-metered, not per-call).
func TestEmitConversationEvents_AssistantMessage_Codex(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	s.runCaps = backend.BackendCapabilities{Kind: "codex"}
	s.lastModel = "codex-mini"
	m, collector := newConvEventsTestManager(t, s)

	in, out := 10, 20
	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UsageEvent{
		Usage: types.UsageData{InputTokens: &in, OutputTokens: &out},
	}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationAssistantMessage)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.assistant_message events, want 1", len(events))
	}
	ev := events[0]
	if _, ok := ev.Payload["entry_id"]; ok {
		t.Errorf("entry_id present as %v, want omitted (codex never carries one)", ev.Payload["entry_id"])
	}
	gotCost, ok := ev.Payload["cost"].(map[string]any)
	if !ok {
		t.Fatalf("cost is not a map: %T %v", ev.Payload["cost"], ev.Payload["cost"])
	}
	if gotCost["input_tokens"] != 10 || gotCost["output_tokens"] != 20 || gotCost["cost_usd"] != 0.0 {
		t.Errorf("cost = %v, want input=10 output=20 cost_usd=0 (codex is subscription-metered)", gotCost)
	}
}

// TestEmitConversationEvents_UserMessage_CarriesText pins that the tracked
// text delivered via RunConfig.OnUserMessage (s.convUserMsgTracker) reaches
// the emitted payload's "text" key verbatim, and is cleared after read.
func TestEmitConversationEvents_UserMessage_CarriesText(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	tracker := &convTextTracker{}
	tracker.record("entry-1", "hello from the user")
	s.convUserMsgTracker = tracker
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{EntryID: "entry-1"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationUserMessage)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.user_message events, want 1", len(events))
	}
	if events[0].Payload["text"] != "hello from the user" {
		t.Errorf("text = %v, want %q", events[0].Payload["text"], "hello from the user")
	}
	if got := tracker.take(); got != "" {
		t.Errorf("tracker not cleared after emit, got %q", got)
	}
}

// TestEmitConversationEvents_AssistantMessage_CarriesText mirrors the user
// case for the ApiBackend completion path, proving OnAssistantMessage's
// delivered text reaches the payload alongside the reused cost.
func TestEmitConversationEvents_AssistantMessage_CarriesText(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	tracker := &convTextTracker{}
	tracker.record("claude-sonnet-5", "hello from the model")
	s.convAssistantMsgTracker = tracker
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.UsageEvent{EntryID: "asst-1"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationAssistantMessage)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.assistant_message events, want 1", len(events))
	}
	if events[0].Payload["text"] != "hello from the model" {
		t.Errorf("text = %v, want %q", events[0].Payload["text"], "hello from the model")
	}
}

// TestEmitConversationEvents_ToolCall_InputOutput pins the full tool-call
// content flow: a ToolCallEvent opens the accumulator, one or more
// ToolCallUpdateEvents append streamed partial-input JSON, and the terminal
// ToolResultEvent drains + decodes it into the payload's "input" key while
// "output" carries the result Content verbatim.
func TestEmitConversationEvents_ToolCall_InputOutput(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolCallEvent{ToolID: "t1", ToolName: "Bash"}})
	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{ToolID: "t1", PartialInput: `{"command":`}})
	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{ToolID: "t1", PartialInput: `"ls -la"}`}})
	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", Content: "file1\nfile2"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationToolCall)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.tool_call events, want 1", len(events))
	}
	ev := events[0]
	input, ok := ev.Payload["input"].(map[string]any)
	if !ok || input["command"] != "ls -la" {
		t.Errorf("input = %v, want {command: \"ls -la\"}", ev.Payload["input"])
	}
	if ev.Payload["output"] != "file1\nfile2" {
		t.Errorf("output = %v, want %q", ev.Payload["output"], "file1\nfile2")
	}
}

// TestEmitConversationEvents_ToolCall_UnparseableInputOmitted pins that a
// tool call whose accumulated partial-input never parses as JSON (e.g. a
// tool with no input at all — the accumulator stays empty) omits "input"
// rather than failing the emission.
func TestEmitConversationEvents_ToolCall_UnparseableInputOmitted(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolCallEvent{ToolID: "t1", ToolName: "Bash"}})
	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", Content: "ok"}})

	events := bufferedRootConvEvents(collector, telemetry.ConversationToolCall)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.tool_call events, want 1", len(events))
	}
	if _, ok := events[0].Payload["input"]; ok {
		t.Errorf("input present as %v, want omitted (nothing accumulated)", events[0].Payload["input"])
	}
}

// TestEmitConversationEvents_ToolCall_SuccessAndError pins that a terminal
// ToolResultEvent produces one conversation.tool_call with the outcome
// derived per telemetry.ToolResultOutcome, and that it NEVER carries a cost
// key regardless of outcome (cost reconciliation rule — model cost stays on
// the assistant event).
func TestEmitConversationEvents_ToolCall_SuccessAndError(t *testing.T) {
	cases := []struct {
		name    string
		isError bool
		content string
		want    string
	}{
		{"success", false, "ok", telemetry.OutcomeSuccess},
		{"plain error", true, "boom", telemetry.OutcomeError},
		{"permission denied", true, "Permission denied: no", telemetry.OutcomeDenied},
		{"blocked", true, "Blocked: policy", telemetry.OutcomeBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := newConvEventsTestSession("k1", "conv-1")
			m, collector := newConvEventsTestManager(t, s)

			m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolCallEvent{ToolID: "t1", ToolName: "Bash"}})
			m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "t1", IsError: tc.isError, Content: tc.content}})

			events := bufferedRootConvEvents(collector, telemetry.ConversationToolCall)
			if len(events) != 1 {
				t.Fatalf("got %d conversation.tool_call events, want 1", len(events))
			}
			ev := events[0]
			if ev.Payload["outcome"] != tc.want {
				t.Errorf("outcome = %v, want %q", ev.Payload["outcome"], tc.want)
			}
			if ev.Payload["tool_name"] != "Bash" {
				t.Errorf("tool_name = %v, want %q", ev.Payload["tool_name"], "Bash")
			}
			if _, ok := ev.Payload["cost"]; ok {
				t.Errorf("cost present as %v, want absent (tool_call never carries cost)", ev.Payload["cost"])
			}
		})
	}
}

// TestStopSession_EmitsDetachedLifecycle pins the "detached" lifecycle seam:
// StopSession fires conversation.lifecycle("detached") after the live session
// is successfully removed, with no persistence check (unlike "deleted").
func TestStopSession_EmitsDetachedLifecycle(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-detach")
	s.newSessionRootContext()
	m, collector := newConvEventsTestManager(t, s)

	if err := m.StopSession("k1"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	events := bufferedRootConvEvents(collector, telemetry.ConversationLifecycle)
	if len(events) != 1 {
		t.Fatalf("got %d conversation.lifecycle events, want 1", len(events))
	}
	ev := events[0]
	if ev.Payload["conversation_id"] != "conv-detach" {
		t.Errorf("conversation_id = %v, want %q", ev.Payload["conversation_id"], "conv-detach")
	}
	if ev.Payload["action"] != string(telemetry.ActionDetached) {
		t.Errorf("action = %v, want %q", ev.Payload["action"], telemetry.ActionDetached)
	}
}

// TestStopSession_UnknownKey_NoEmit pins that stopping a key with no
// installed session (the idempotent-retry path) emits nothing — there is no
// conversation to detach.
func TestStopSession_UnknownKey_NoEmit(t *testing.T) {
	m := &Manager{sessions: make(map[string]*engineSession)}
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	m.SetConversationEventsTelemetry(collector)

	if err := m.StopSession("missing"); err == nil {
		t.Fatal("StopSession on unknown key returned nil error, want not-found")
	}
	if got := len(collector.BufferedEvents()); got != 0 {
		t.Fatalf("got %d buffered events, want 0", got)
	}
}

// TestEmitConversationsDeleted pins the retention/explicit-delete seam: one
// conversation.lifecycle("deleted") fires per supplied ID, and an empty slice
// (e.g. a dry-run result, which callers must never pass here) fires nothing.
func TestEmitConversationsDeleted(t *testing.T) {
	m := &Manager{sessions: make(map[string]*engineSession)}
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	m.SetConversationEventsTelemetry(collector)

	m.EmitConversationsDeleted([]string{"conv-a", "conv-b"})

	events := bufferedRootConvEvents(collector, telemetry.ConversationLifecycle)
	if len(events) != 2 {
		t.Fatalf("got %d conversation.lifecycle events, want 2", len(events))
	}
	got := map[string]bool{}
	for _, ev := range events {
		if ev.Payload["action"] != string(telemetry.ActionDeleted) {
			t.Errorf("action = %v, want %q", ev.Payload["action"], telemetry.ActionDeleted)
		}
		id, _ := ev.Payload["conversation_id"].(string)
		got[id] = true
	}
	if !got["conv-a"] || !got["conv-b"] {
		t.Errorf("got conversation_ids %v, want conv-a and conv-b", got)
	}

	collector2 := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	m.SetConversationEventsTelemetry(collector2)
	m.EmitConversationsDeleted(nil)
	if got := len(collector2.BufferedEvents()); got != 0 {
		t.Fatalf("got %d buffered events for nil ids, want 0", got)
	}
}

// TestEmitConversationEvents_AppContextStamped pins that a session's
// client-supplied application context reaches the emitted event's context
// map under "app_context" — the dimension an enterprise consumer uses to
// attribute an event to the surface (tab, pane) it came from.
func TestEmitConversationEvents_AppContextStamped(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	s.config.AppContext = map[string]string{"tab": "tab-7", "sub_tab": "instance-2"}
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{
		Data: &types.UserTurnPersistedEvent{EntryID: "e1"},
	})

	events := bufferedRootConvEvents(collector, telemetry.ConversationUserMessage)
	if len(events) != 1 {
		t.Fatalf("got %d user_message events, want 1", len(events))
	}
	appCtx, ok := events[0].Context["app_context"].(map[string]any)
	if !ok {
		t.Fatalf("app_context missing or wrong type in context: %#v", events[0].Context)
	}
	if appCtx["tab"] != "tab-7" {
		t.Errorf("app_context[tab] = %v, want tab-7", appCtx["tab"])
	}
	if appCtx["sub_tab"] != "instance-2" {
		t.Errorf("app_context[sub_tab] = %v, want instance-2", appCtx["sub_tab"])
	}
}

// TestEmitConversationEvents_NoAppContext_KeyAbsent pins the default: a
// consumer that supplies no application context emits exactly the event
// shape it emitted before the field existed — no empty "app_context" key
// for a downstream schema to special-case.
func TestEmitConversationEvents_NoAppContext_KeyAbsent(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, collector := newConvEventsTestManager(t, s)

	m.emitConversationEvents("k1", "run-1", types.NormalizedEvent{
		Data: &types.UserTurnPersistedEvent{EntryID: "e1"},
	})

	events := bufferedRootConvEvents(collector, telemetry.ConversationUserMessage)
	if len(events) != 1 {
		t.Fatalf("got %d user_message events, want 1", len(events))
	}
	if _, present := events[0].Context["app_context"]; present {
		t.Errorf("app_context key present with no client value: %#v", events[0].Context)
	}
}

// TestSetAppContext_ReplacesAndClears pins the update path: any addressed
// command carrying appContext replaces the stored map for the rest of the
// session, and an empty map clears it rather than leaving a stale identity
// stamped on every later event.
func TestSetAppContext_ReplacesAndClears(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	s.config.AppContext = map[string]string{"tab": "old"}
	m, _ := newConvEventsTestManager(t, s)

	if !m.SetAppContext("k1", map[string]string{"tab": "new"}) {
		t.Fatal("SetAppContext returned false for a live session")
	}
	if got := s.config.AppContext["tab"]; got != "new" {
		t.Errorf("stored app context tab = %q, want new", got)
	}

	if !m.SetAppContext("k1", map[string]string{}) {
		t.Fatal("SetAppContext returned false when clearing")
	}
	if s.config.AppContext != nil {
		t.Errorf("empty map did not clear stored app context: %#v", s.config.AppContext)
	}

	if m.SetAppContext("nope", map[string]string{"tab": "x"}) {
		t.Error("SetAppContext returned true for an unknown session key")
	}
}

// TestSetAppContext_CopiesCallerMap pins that the stored value is a copy: a
// caller that reuses or mutates its map after the call must not retroactively
// change what later events report.
func TestSetAppContext_CopiesCallerMap(t *testing.T) {
	s := newConvEventsTestSession("k1", "conv-1")
	m, _ := newConvEventsTestManager(t, s)

	caller := map[string]string{"tab": "tab-1"}
	m.SetAppContext("k1", caller)
	caller["tab"] = "mutated"

	if got := s.config.AppContext["tab"]; got != "tab-1" {
		t.Errorf("stored app context aliased the caller map: got %q, want tab-1", got)
	}
}
