package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/google/jsonschema-go/jsonschema"
)

// conversationSchemaPath is the published contract enterprise consumers
// build their ingestion against. It is validated here against events this
// package actually emits, so the two cannot drift: a payload change that
// the schema does not describe fails this test rather than silently
// breaking a downstream consumer that trusted the published document.
const conversationSchemaPath = "../../../docs/observability/conversation-events.schema.json"

func loadConversationSchema(t *testing.T) *jsonschema.Resolved {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(conversationSchemaPath))
	if err != nil {
		t.Fatalf("read published schema: %v", err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("published schema is not valid JSON Schema: %v", err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatalf("resolve published schema: %v", err)
	}
	return resolved
}

// emitAndCapture runs fn against a real ConversationEmitter wired to a
// sink-less collector, then returns the emitted events as generic JSON —
// the exact bytes a downstream consumer receives off the wire.
func emitAndCapture(t *testing.T, fn func(e *ConversationEmitter)) []map[string]any {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	defer c.Close()
	fn(NewConversationEmitter(c))

	var out []map[string]any
	for _, ev := range c.BufferedEvents() {
		raw, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshal emitted event: %v", err)
		}
		var generic map[string]any
		if err := json.Unmarshal(raw, &generic); err != nil {
			t.Fatalf("unmarshal emitted event: %v", err)
		}
		out = append(out, generic)
	}
	return out
}

// TestPublishedSchema_ValidatesRealEmittedEvents is the anti-drift gate on
// the published contract. Every event this family emits — all four names,
// with cost, extension metadata, and client app context populated — must
// validate against the committed schema document.
func TestPublishedSchema_ValidatesRealEmittedEvents(t *testing.T) {
	schema := loadConversationSchema(t)

	ctx := map[string]any{
		"session_id":      "sess-1",
		"conversation_id": "conv-1",
		"run_id":          "run-1",
		"trace_id":        "4bf92f3577b34da6a3ce929d0e0e4736",
		"extension":       "orion",
		"app_context":     map[string]any{"client": "desktop", "tab_id": "tab-7"},
	}

	events := emitAndCapture(t, func(e *ConversationEmitter) {
		e.SetBeforeEvent(func(BeforeEventInfo) map[string]any {
			return map[string]any{"department": "cloudops", "agent_pack": "v3"}
		})
		e.UserMessage(ctx, "conv-1", "entry-1", "run-1", "", "hello")
		e.AssistantMessage(ctx, "conv-1", "entry-2", "run-1", "", "claude-sonnet-5", "hi", &CallCost{
			InputTokens: 10, OutputTokens: 5, CacheReadInputTokens: 900, CacheCreationInputTokens: 3, CostUsd: 0.000131,
		})
		e.AssistantMessage(ctx, "conv-1", "entry-3", "run-1", "", "claude-sonnet-5", "no cost reported", nil)
		e.ToolCall(ctx, "conv-1", "entry-4", "toolu_1", "Bash", "run-1", "", OutcomeSuccess,
			map[string]any{"command": "ls"}, "file.txt")
		e.ToolCall(ctx, "conv-1", "entry-5", "toolu_2", "Bash", "run-1", "dispatch-1", OutcomeError, nil, "boom")
		for _, action := range []LifecycleAction{ActionCreated, ActionResumed, ActionCompacted, ActionCleared, ActionDetached, ActionDeleted} {
			e.Lifecycle(ctx, "conv-1", action, "")
		}
	})

	if len(events) != 11 {
		t.Fatalf("captured %d events, want 11 (one per emission above)", len(events))
	}
	for i, ev := range events {
		if err := schema.Validate(ev); err != nil {
			t.Errorf("event %d (%v) does not validate against the published schema: %v", i, ev["name"], err)
		}
	}
}

// TestPublishedSchema_ValidatesSegmentedEvent pins that the parts an
// oversize event is delivered as conform to the published contract — the
// segment block is part of what a consumer is promised, so a part that
// failed validation would be a part a schema-enforcing ingester rejects.
func TestPublishedSchema_ValidatesSegmentedEvent(t *testing.T) {
	schema := loadConversationSchema(t)
	ctx := map[string]any{"conversation_id": "conv-1", "run_id": "run-1", "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"}
	events := emitAndCapture(t, func(e *ConversationEmitter) {
		e.ToolCall(ctx, "conv-1", "entry-4", "toolu_1", "Bash", "run-1", "", OutcomeSuccess,
			map[string]any{"command": "cat big"}, strings.Repeat("output line\n", 4000))
	})
	if len(events) != 1 {
		t.Fatalf("captured %d events, want 1", len(events))
	}
	raw, err := json.Marshal(events[0])
	if err != nil {
		t.Fatal(err)
	}
	var ev Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatal(err)
	}
	parts, field, err := segmentEvent(ev, 8_000)
	if err != nil || field != "/output" || len(parts) < 2 {
		t.Fatalf("segmentEvent: parts=%d field=%q err=%v", len(parts), field, err)
	}
	for i, part := range parts {
		b, err := json.Marshal(part)
		if err != nil {
			t.Fatal(err)
		}
		var generic map[string]any
		if err := json.Unmarshal(b, &generic); err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(generic); err != nil {
			t.Errorf("part %d does not validate against the published schema: %v", i, err)
		}
	}
}

// TestPublishedSchema_RejectsOffContractEvent proves the schema actually
// constrains rather than accepting anything: an event carrying a name
// outside the frozen vocabulary, and a lifecycle action outside the frozen
// action list, must both fail validation. Without this, the test above
// would pass against a schema that validated everything.
func TestPublishedSchema_RejectsOffContractEvent(t *testing.T) {
	schema := loadConversationSchema(t)

	cases := []struct {
		name  string
		event map[string]any
	}{
		{
			name: "unknown event name",
			event: map[string]any{
				"name": "conversation.telepathy", "ts": "2026-09-05T00:00:00Z", "schema": 4,
				"component": "engine", "event_id": "e1", "trace_id": "", "parent_span_id": "",
				"payload": map[string]any{"conversation_id": "c1"},
			},
		},
		{
			name: "segment block missing its sha256",
			event: map[string]any{
				"name": "conversation.tool_call", "ts": "2026-09-05T00:00:00Z", "schema": 4,
				"component": "engine", "event_id": "e1", "trace_id": "", "parent_span_id": "",
				"payload": map[string]any{"conversation_id": "c1", "output": "x", "segment": map[string]any{
					"part": 1, "parts": 2, "field": "/output", "total_bytes": 10,
				}},
			},
		},
		{
			name: "lifecycle action outside the frozen vocabulary",
			event: map[string]any{
				"name": "conversation.lifecycle", "ts": "2026-09-05T00:00:00Z", "schema": 4,
				"component": "engine", "event_id": "e1", "trace_id": "", "parent_span_id": "",
				"payload": map[string]any{"conversation_id": "c1", "action": "vaporized"},
			},
		},
		{
			name: "malformed trace id",
			event: map[string]any{
				"name": "conversation.user_message", "ts": "2026-09-05T00:00:00Z", "schema": 4,
				"component": "engine", "event_id": "e1", "trace_id": "not-a-trace", "parent_span_id": "",
				"payload": map[string]any{"conversation_id": "c1"},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := schema.Validate(tc.event); err == nil {
				t.Error("published schema accepted an off-contract event; it does not constrain the stream")
			}
		})
	}
}
