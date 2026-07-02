package conversation

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildContextInjectionMessage pins the wire shape: a single typed block
// carrying the rendered text and the structured paths.
func TestBuildContextInjectionMessage(t *testing.T) {
	msg := BuildContextInjectionMessage(
		[]string{"/repo/sub/AGENTS.md"},
		"# Context from /repo/sub/AGENTS.md\nbody")
	if msg.Role != "user" {
		t.Fatalf("expected role=user, got %q", msg.Role)
	}
	blocks, ok := msg.Content.([]types.LlmContentBlock)
	if !ok || len(blocks) != 1 {
		t.Fatalf("expected a single content block, got %#v", msg.Content)
	}
	if blocks[0].Type != ContextInjectionBlockType {
		t.Errorf("expected type %q, got %q", ContextInjectionBlockType, blocks[0].Type)
	}
	if blocks[0].Text == "" {
		t.Error("expected rendered text on the block")
	}
	if len(blocks[0].ContextPaths) != 1 || blocks[0].ContextPaths[0] != "/repo/sub/AGENTS.md" {
		t.Errorf("expected ContextPaths=[/repo/sub/AGENTS.md], got %v", blocks[0].ContextPaths)
	}
}

// TestCollectInjectedContextPaths_Typed recovers paths from a typed block built
// in-memory (the live runloop shape).
func TestCollectInjectedContextPaths_Typed(t *testing.T) {
	conv := CreateConversation("ci-typed", "", "m")
	conv.Messages = append(conv.Messages,
		BuildContextInjectionMessage([]string{"/a/AGENTS.md", "/b/ION.md"}, "rendered"))

	got := CollectInjectedContextPaths(conv)
	if !got["/a/AGENTS.md"] || !got["/b/ION.md"] {
		t.Errorf("expected both paths recovered, got %v", got)
	}
	if len(got) != 2 {
		t.Errorf("expected exactly 2 paths, got %v", got)
	}
}

// TestCollectInjectedContextPaths_RoundTrip recovers paths after a JSON
// round-trip, where the typed []LlmContentBlock lands as []interface{} with
// map[string]any blocks — the on-disk reload shape.
func TestCollectInjectedContextPaths_RoundTrip(t *testing.T) {
	orig := BuildContextInjectionMessage([]string{"/a/AGENTS.md"}, "rendered")
	raw, err := json.Marshal(orig)
	if err != nil {
		t.Fatal(err)
	}
	var decoded types.LlmMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	conv := CreateConversation("ci-rt", "", "m")
	conv.Messages = append(conv.Messages, decoded)

	got := CollectInjectedContextPaths(conv)
	if !got["/a/AGENTS.md"] {
		t.Errorf("expected /a/AGENTS.md recovered after JSON round-trip, got %v", got)
	}
}

// TestCollectInjectedContextPaths_IgnoresProse is the core regression guard: a
// plain text user message whose body contains the "# Context from" marker line
// carries no context_injection block and must contribute nothing.
func TestCollectInjectedContextPaths_IgnoresProse(t *testing.T) {
	conv := CreateConversation("ci-prose", "", "m")
	AddUserMessage(conv, "log dump:\n# Context from /foreign/AGENTS.md\nbody")

	got := CollectInjectedContextPaths(conv)
	if len(got) != 0 {
		t.Errorf("prose containing the marker must not be recovered, got %v", got)
	}
}

// TestAddContextInjectionMessage_PersistVsTransient pins that the persistent
// path writes an entry to the tree while the transient path does not, and both
// append the LLM-visible message.
func TestAddContextInjectionMessage_PersistVsTransient(t *testing.T) {
	// Persistent: entry tree gets the block.
	convP := CreateConversation("ci-persist", "", "m")
	beforeEntries := len(convP.Entries)
	AddContextInjectionMessage(convP, []string{"/a/AGENTS.md"}, "rendered", false)
	if len(convP.Messages) != 1 {
		t.Fatalf("persistent: expected 1 message, got %d", len(convP.Messages))
	}
	if len(convP.Entries) != beforeEntries+1 {
		t.Errorf("persistent: expected an entry appended, before=%d after=%d", beforeEntries, len(convP.Entries))
	}

	// Transient: message present, no entry appended.
	convT := CreateConversation("ci-transient", "", "m")
	beforeEntriesT := len(convT.Entries)
	AddContextInjectionMessage(convT, []string{"/a/AGENTS.md"}, "rendered", true)
	if len(convT.Messages) != 1 {
		t.Fatalf("transient: expected 1 message, got %d", len(convT.Messages))
	}
	if len(convT.Entries) != beforeEntriesT {
		t.Errorf("transient: expected no entry appended, before=%d after=%d", beforeEntriesT, len(convT.Entries))
	}
}
