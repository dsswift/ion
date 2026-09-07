package telemetry

import (
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// newBufferingCollector returns an enabled Collector with no sinks, so
// Event() appends to the in-memory buffer without ever flushing to disk or
// network — the tests below inspect c.buffer directly (same package).
func newBufferingCollector(t *testing.T) *Collector {
	t.Helper()
	return NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
}

func lastEvent(t *testing.T, c *Collector) Event {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.buffer) == 0 {
		t.Fatal("expected at least one buffered event")
	}
	return c.buffer[len(c.buffer)-1]
}

func TestConversationEmitter_UserMessage_PayloadShape(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.UserMessage(nil, "conv-1", "entry-1", "run-1", "", "hello from the user")

	ev := lastEvent(t, c)
	if ev.Name != ConversationUserMessage {
		t.Fatalf("expected event name %q, got %q", ConversationUserMessage, ev.Name)
	}
	want := map[string]any{"conversation_id": "conv-1", "entry_id": "entry-1", "run_id": "run-1", "text": "hello from the user"}
	for k, v := range want {
		if ev.Payload[k] != v {
			t.Errorf("payload[%q] = %v, want %v", k, ev.Payload[k], v)
		}
	}
	if _, ok := ev.Payload["dispatch_id"]; ok {
		t.Errorf("expected dispatch_id omitted for empty value, got %v", ev.Payload["dispatch_id"])
	}
}

func TestConversationEmitter_AssistantMessage_CostOmittedWhenNil(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.AssistantMessage(nil, "conv-1", "entry-1", "run-1", "", "claude-sonnet-5", "hello from the model", nil)

	ev := lastEvent(t, c)
	if _, ok := ev.Payload["cost"]; ok {
		t.Fatalf("expected no cost key when cost is nil, got %v", ev.Payload["cost"])
	}
	if ev.Payload["model"] != "claude-sonnet-5" {
		t.Errorf("payload[model] = %v, want claude-sonnet-5", ev.Payload["model"])
	}
	if ev.Payload["text"] != "hello from the model" {
		t.Errorf("payload[text] = %v, want %q", ev.Payload["text"], "hello from the model")
	}
}

func TestConversationEmitter_AssistantMessage_CostPresentWhenSet(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.AssistantMessage(nil, "conv-1", "entry-1", "run-1", "", "claude-sonnet-5", "", &CallCost{
		InputTokens:              100,
		OutputTokens:             50,
		CacheReadInputTokens:     10,
		CacheCreationInputTokens: 5,
		CostUsd:                  0.0123,
	})

	ev := lastEvent(t, c)
	cost, ok := ev.Payload["cost"].(map[string]any)
	if !ok {
		t.Fatalf("expected cost to be a map, got %T: %v", ev.Payload["cost"], ev.Payload["cost"])
	}
	want := map[string]any{
		"input_tokens":                100,
		"output_tokens":               50,
		"cache_read_input_tokens":     10,
		"cache_creation_input_tokens": 5,
		"cost_usd":                    0.0123,
	}
	for k, v := range want {
		if cost[k] != v {
			t.Errorf("cost[%q] = %v, want %v", k, cost[k], v)
		}
	}
}

func TestConversationEmitter_ToolCall_NeverCarriesCost(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.ToolCall(nil, "conv-1", "entry-1", "tu-1", "Bash", "run-1", "", OutcomeSuccess, map[string]any{"command": "ls"}, "file1\nfile2")

	ev := lastEvent(t, c)
	if _, ok := ev.Payload["cost"]; ok {
		t.Fatalf("ToolCall payload must never carry a cost key, got %v", ev.Payload["cost"])
	}
	if ev.Payload["outcome"] != OutcomeSuccess {
		t.Errorf("payload[outcome] = %v, want %v", ev.Payload["outcome"], OutcomeSuccess)
	}
	if _, ok := ev.Payload["entry_id"]; !ok {
		t.Errorf("expected entry_id present when non-empty")
	}
	input, ok := ev.Payload["input"].(map[string]any)
	if !ok || input["command"] != "ls" {
		t.Errorf("payload[input] = %v, want {command: ls}", ev.Payload["input"])
	}
	if ev.Payload["output"] != "file1\nfile2" {
		t.Errorf("payload[output] = %v, want %q", ev.Payload["output"], "file1\nfile2")
	}
}

func TestConversationEmitter_ToolCall_MissingEntryIDOmitted(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.ToolCall(nil, "conv-1", "", "tu-1", "Bash", "run-1", "", OutcomeError, nil, "")

	ev := lastEvent(t, c)
	if _, ok := ev.Payload["entry_id"]; ok {
		t.Errorf("expected entry_id omitted when empty, got %v", ev.Payload["entry_id"])
	}
	if _, ok := ev.Payload["input"]; ok {
		t.Errorf("expected input omitted when nil, got %v", ev.Payload["input"])
	}
}

func TestConversationEmitter_Lifecycle_SixFrozenActions(t *testing.T) {
	cases := []struct {
		action LifecycleAction
		want   string
	}{
		{ActionCreated, "created"},
		{ActionResumed, "resumed"},
		{ActionCompacted, "compacted"},
		{ActionCleared, "cleared"},
		{ActionDetached, "detached"},
		{ActionDeleted, "deleted"},
	}
	if len(cases) != 6 {
		t.Fatalf("expected exactly 6 frozen lifecycle actions, got %d", len(cases))
	}

	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	for _, tc := range cases {
		e.Lifecycle(nil, "conv-1", tc.action, "")
		ev := lastEvent(t, c)
		if ev.Payload["action"] != tc.want {
			t.Errorf("action %v: payload[action] = %v, want %v", tc.action, ev.Payload["action"], tc.want)
		}
	}
}

// TestConversationEmitter_NilReceiver_NoOp proves a nil-receiver (or a
// non-nil emitter with a nil collector) never reaches the collector: it
// shares a single real, buffering collector with a live sibling emitter, and
// asserts the buffer stays exactly as it was before the nil calls — a
// collector.Event call from the nil-guarded path would append to that same
// buffer and fail the assertion.
func TestConversationEmitter_NilReceiver_NoOp(t *testing.T) {
	c := newBufferingCollector(t)

	var e *ConversationEmitter
	e.UserMessage(nil, "conv-1", "entry-1", "run-1", "", "text")
	e.AssistantMessage(nil, "conv-1", "entry-1", "run-1", "", "model", "text", &CallCost{})
	e.ToolCall(nil, "conv-1", "entry-1", "tu-1", "Bash", "run-1", "", OutcomeSuccess, nil, "")
	e.Lifecycle(nil, "conv-1", ActionCreated, "")

	empty := NewConversationEmitter(nil)
	empty.UserMessage(nil, "conv-1", "entry-1", "run-1", "", "text")
	empty.AssistantMessage(nil, "conv-1", "entry-1", "run-1", "", "model", "text", nil)
	empty.ToolCall(nil, "conv-1", "entry-1", "tu-1", "Bash", "run-1", "", OutcomeSuccess, nil, "")
	empty.Lifecycle(nil, "conv-1", ActionCreated, "")

	c.mu.Lock()
	count := len(c.buffer)
	c.mu.Unlock()
	if count != 0 {
		t.Fatalf("expected the sibling collector's buffer untouched by nil-receiver calls, got %d events", count)
	}
}

func TestToolResultOutcome_Derivation(t *testing.T) {
	cases := []struct {
		name    string
		isError bool
		content string
		want    string
	}{
		{"success", false, "", OutcomeSuccess},
		{"success with content ignored", false, "irrelevant", OutcomeSuccess},
		{"plain execution error", true, "Error: tool \"Bash\" exceeded 60s deadline. Narrow the request or split it into smaller calls.", OutcomeError},
		{"unknown tool error", true, "Unknown tool: Frobnicate", OutcomeError},
		{"permission denied", true, "Permission denied: user declined", OutcomeDenied},
		{"client gate blocked", true, "Blocked: client tool gate denied", OutcomeBlocked},
		{"hook blocked", true, "Blocked: hook returned deny", OutcomeBlocked},
		{"sandbox blocked", true, "Sandbox blocked: network egress disabled", OutcomeBlocked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ToolResultOutcome(tc.isError, tc.content)
			if got != tc.want {
				t.Errorf("ToolResultOutcome(%v, %q) = %q, want %q", tc.isError, tc.content, got, tc.want)
			}
		})
	}
}

// TestConversationEmitter_SeqIsPerConversationAndMonotonic pins the ordering
// contract: every conversation.* event carries a seq that counts up from 1
// per conversation, independently across conversations, and a deleted
// conversation's counter is released. Non-conversation events carry none.
func TestConversationEmitter_SeqIsPerConversationAndMonotonic(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)

	e.UserMessage(nil, "conv-a", "e1", "run-1", "", "one")
	e.UserMessage(nil, "conv-b", "e2", "run-2", "", "other conversation")
	e.ToolCall(nil, "conv-a", "e3", "toolu_1", "Bash", "run-1", "", OutcomeSuccess, nil, "out")
	e.AssistantMessage(nil, "conv-a", "e4", "run-1", "", "m", "reply", nil)
	e.Lifecycle(nil, "conv-a", ActionDeleted, "")
	c.Event("engine.started", map[string]any{"conversation_id": "conv-a"}, nil)
	e.UserMessage(nil, "conv-a", "e5", "run-3", "", "after delete the counter restarts")

	c.mu.Lock()
	events := append([]Event(nil), c.buffer...)
	c.mu.Unlock()
	if len(events) != 7 {
		t.Fatalf("buffered %d events, want 7", len(events))
	}
	wantSeq := []int64{1, 1, 2, 3, 4, 0, 1}
	for i, want := range wantSeq {
		got, _ := events[i].Payload["seq"].(int64) //nolint:errcheck // absent reads as 0, which is the assertion for the non-conversation event
		if got != want {
			t.Errorf("event %d (%s): seq = %d, want %d", i, events[i].Name, got, want)
		}
	}
	if _, present := events[5].Payload["seq"]; present {
		t.Error("a non-conversation event must carry no seq key at all")
	}
}

// TestCollector_SeqAndTsAgreeUnderConcurrency pins that ts order and seq
// order never disagree for one conversation, which only holds because both
// are taken under one lock: many goroutines emitting concurrently must
// produce events whose ts, sorted, yields strictly increasing seq.
func TestCollector_SeqAndTsAgreeUnderConcurrency(t *testing.T) {
	c := newBufferingCollector(t)
	e := NewConversationEmitter(c)
	const n = 500
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e.UserMessage(nil, "conv-race", fmt.Sprintf("e%d", i), "run", "", "x")
		}(i)
	}
	wg.Wait()

	c.mu.Lock()
	events := append([]Event(nil), c.buffer...)
	c.mu.Unlock()
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].Ts != events[j].Ts {
			ti, _ := time.Parse(time.RFC3339Nano, events[i].Ts)
			tj, _ := time.Parse(time.RFC3339Nano, events[j].Ts)
			return ti.Before(tj)
		}
		return events[i].Payload["seq"].(int64) < events[j].Payload["seq"].(int64) //nolint:errcheck // stamped by the collector
	})
	for i := 1; i < len(events); i++ {
		prev, cur := events[i-1].Payload["seq"].(int64), events[i].Payload["seq"].(int64) //nolint:errcheck // stamped by the collector
		if cur != prev+1 {
			t.Fatalf("after sorting by (ts, seq), seq went %d -> %d at index %d: ts and seq disagree", prev, cur, i)
		}
	}
}
