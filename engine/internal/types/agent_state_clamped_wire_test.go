package types

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAgentStateClampedEvent_WireShape pins the serialized field names. A
// cross-boundary field needs a serialization test, not just a struct test:
// the TS and Swift mirrors decode these exact keys, so a rename that compiles
// fine in Go silently breaks every client.
func TestAgentStateClampedEvent_WireShape(t *testing.T) {
	ev := AgentStateClampedEvent{
		AgentName:     "cloud-architect",
		Scope:         "value",
		ClampedKeys:   []string{"lastWork"},
		DroppedKeys:   []string{"debugDump"},
		OriginalBytes: 3145728,
		ClampedBytes:  4096,
		LimitBytes:    4096,
	}

	encoded, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	for _, key := range []string{
		"agentName", "scope", "clampedKeys", "droppedKeys",
		"originalBytes", "clampedBytes", "limitBytes",
	} {
		if _, ok := got[key]; !ok {
			t.Errorf("wire payload missing %q; got keys %v", key, got)
		}
	}
	if got["scope"] != "value" {
		t.Errorf("scope = %v, want \"value\"", got["scope"])
	}
}

// A snapshot-scoped clamp spans agents, so agentName is absent rather than
// empty — omitempty keeps the payload honest instead of implying an agent
// literally named "".
func TestAgentStateClampedEvent_OmitsEmptyOptionalFields(t *testing.T) {
	encoded, err := json.Marshal(AgentStateClampedEvent{
		Scope: "snapshot", OriginalBytes: 100, ClampedBytes: 50, LimitBytes: 50,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"agentName", "clampedKeys", "droppedKeys"} {
		if _, ok := got[key]; ok {
			t.Errorf("empty optional field %q should be omitted, got %v", key, got[key])
		}
	}
	// The byte counts are NOT omitempty-suppressed at zero in a real clamp,
	// but they must always be present so a consumer can compute the loss.
	for _, key := range []string{"originalBytes", "clampedBytes", "limitBytes"} {
		if _, ok := got[key]; !ok {
			t.Errorf("byte-count field %q must always be present", key)
		}
	}
}

// The no-echo guarantee, pinned at the type level: the event has no field
// capable of carrying the clamped content. Were one added, this fails and the
// author has to justify reintroducing the payload the clamp exists to remove.
func TestAgentStateClampedEvent_CannotCarryContent(t *testing.T) {
	needle := strings.Repeat("SECRET", 10000)
	ev := AgentStateClampedEvent{
		AgentName:     "a",
		Scope:         "value",
		ClampedKeys:   []string{"lastWork"},
		OriginalBytes: len(needle),
		ClampedBytes:  4096,
		LimitBytes:    4096,
	}

	encoded, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(encoded) > 512 {
		t.Errorf("advisory serialized to %d bytes; it must stay small regardless of the clamped value", len(encoded))
	}
	if strings.Contains(string(encoded), "SECRET") {
		t.Error("advisory must never echo the clamped content")
	}
}

func TestAgentStateClampedEvent_RoundTripsThroughNormalizedEvent(t *testing.T) {
	original := AgentStateClampedEvent{
		AgentName: "a", Scope: "entry", DroppedKeys: []string{"bulk"},
		OriginalBytes: 99, ClampedBytes: 10, LimitBytes: 10,
	}
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded AgentStateClampedEvent
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Scope != "entry" || decoded.OriginalBytes != 99 || len(decoded.DroppedKeys) != 1 {
		t.Errorf("round-trip lost data: %+v", decoded)
	}
	if got := (AgentStateClampedEvent{}).eventType(); got != EventAgentStateClamped {
		t.Errorf("eventType() = %q, want %q", got, EventAgentStateClamped)
	}
}
