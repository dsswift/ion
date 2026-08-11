package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestInjectionKind_PersistedAndFlattened pins the full round-trip for
// engine-side injected user turns classified with InjectionKind:
//
//   - AddUserMessageWithKind stamps InjectionKind on the persisted MessageData
//     entry so the classification survives a Save → Load cycle.
//   - flattenEntries propagates InjectionKind onto the SessionMessage so
//     consumers can classify the turn on historical reload.
//
// The engine emits the field; filtering is the consumer's opinion. This test
// asserts the engine's contract: the kind is present on the SessionMessage with
// the correct value. A separate ordinary turn (empty kind) is asserted not to
// carry a non-empty InjectionKind.
//
// Revert-red guarantee: removing the InjectionKind field from MessageData or
// the flattenEntries propagation causes the agent_completion assertion to fail.
func TestInjectionKind_PersistedAndFlattened(t *testing.T) {
	conv := CreateConversation("test-injection-kind", "sys", "model")

	// Ordinary user turn — no kind.
	AddUserMessage(conv, "What should I work on today?")

	// Engine-injected completion delivery — kind="agent_completion".
	AddUserMessageWithKind(conv, "[Agent Dev Lead completed in 12s]\n\nHere is the output.", "agent_completion")

	// Another ordinary turn after the injection.
	AddUserMessage(conv, "Thanks, continue.")

	msgs := flattenEntries(conv)

	// Three entries should produce three rows (all non-tool-result user turns).
	if len(msgs) != 3 {
		t.Fatalf("expected 3 flattened messages, got %d", len(msgs))
	}

	// First row: ordinary — no injection kind.
	if msgs[0].InjectionKind != "" {
		t.Errorf("row 0: expected empty InjectionKind for ordinary turn, got %q", msgs[0].InjectionKind)
	}

	// Second row: agent completion — must carry the kind.
	if msgs[1].InjectionKind != "agent_completion" {
		t.Errorf("row 1: expected InjectionKind=%q, got %q", "agent_completion", msgs[1].InjectionKind)
	}
	if msgs[1].Content == "" {
		t.Errorf("row 1: content must not be empty")
	}

	// Third row: ordinary — no injection kind.
	if msgs[2].InjectionKind != "" {
		t.Errorf("row 2: expected empty InjectionKind for ordinary turn, got %q", msgs[2].InjectionKind)
	}
}

// TestAddUserMessageWithKind_EmptyKindDelegates pins that an empty kind is
// identical to calling AddUserMessage: the entry carries no InjectionKind
// field (omitempty), so the persisted JSON is identical.
func TestAddUserMessageWithKind_EmptyKindDelegates(t *testing.T) {
	conv1 := CreateConversation("test-kind-empty-a", "sys", "model")
	conv2 := CreateConversation("test-kind-empty-b", "sys", "model")

	AddUserMessage(conv1, "hello")
	AddUserMessageWithKind(conv2, "hello", "")

	if len(conv1.Entries) != 1 || len(conv2.Entries) != 1 {
		t.Fatalf("each conversation should have exactly one entry")
	}

	md1 := asMessageData(conv1.Entries[0].Data)
	md2 := asMessageData(conv2.Entries[0].Data)
	if md1 == nil || md2 == nil {
		t.Fatal("MessageData is nil")
	}

	if md1.InjectionKind != "" || md2.InjectionKind != "" {
		t.Errorf("expected empty InjectionKind for both, got %q and %q", md1.InjectionKind, md2.InjectionKind)
	}
}

// TestInjectionKind_MessageDataPersisted pins that AddUserMessageWithKind
// stamps InjectionKind on the persisted MessageData entry (not just the
// in-memory slice). Revert-red: removing the InjectionKind field from the
// MessageData struct makes this assertion fail.
func TestInjectionKind_MessageDataPersisted(t *testing.T) {
	conv := CreateConversation("test-kind-persisted", "sys", "model")

	AddUserMessageWithKind(conv, "dispatch result body", "agent_completion")

	if len(conv.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(conv.Entries))
	}

	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatal("entry data is not MessageData")
	}
	if md.InjectionKind != "agent_completion" {
		t.Errorf("expected InjectionKind=%q on persisted entry, got %q", "agent_completion", md.InjectionKind)
	}
}

// TestDegradedSteer_MarkerFlattensToSteerRow pins the reload half of the
// degraded-steer contract. The backend persists a user entry plus an
// EntrySteerMarker (runloop_helpers.go); this asserts flattenEntries replays
// that marker as a markerKind:"steer" row carrying the message length, which
// is what lets a client rebuild the same divider it rendered live.
//
// Live/reload agreement is the whole point: a client that renders a divider
// from engine_prompt_injected and then loses it on rehydrate produces a
// transcript that changes shape under the operator.
func TestDegradedSteer_MarkerFlattensToSteerRow(t *testing.T) {
	conv := CreateConversation("test-steer-fallback-flatten", "sys", "model")

	prompt := "[SYSTEM] Dispatch check-in"
	AddUserMessageWithKind(conv, prompt, string(types.InjectionKindCheckIn))
	AppendEntry(conv, EntrySteerMarker, SteerMarkerData{MessageLength: len(prompt)})

	msgs := flattenEntries(conv)

	var userRow, steerRow *int
	for i := range msgs {
		switch {
		case msgs[i].Role == "user":
			idx := i
			userRow = &idx
		case msgs[i].MarkerKind == "steer":
			idx := i
			steerRow = &idx
		}
	}

	if userRow == nil {
		t.Fatal("expected the injected user turn to flatten")
	}
	if msgs[*userRow].InjectionKind != string(types.InjectionKindCheckIn) {
		t.Errorf("user row InjectionKind = %q, want %q", msgs[*userRow].InjectionKind, types.InjectionKindCheckIn)
	}
	if steerRow == nil {
		t.Fatal("expected a markerKind=steer row replayed from the persisted marker")
	}
	if msgs[*steerRow].MarkerMessageLength != len(prompt) {
		t.Errorf("steer row MarkerMessageLength = %d, want %d", msgs[*steerRow].MarkerMessageLength, len(prompt))
	}
	// Ordering matters: the marker follows the turn it describes, matching the
	// live sequence (prompt injected, then divider).
	if *steerRow < *userRow {
		t.Errorf("steer marker row (%d) must follow the user row (%d)", *steerRow, *userRow)
	}
}
