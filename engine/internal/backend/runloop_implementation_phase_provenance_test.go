package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestAppendInboundUserEntryPersistsImplementationPhase pins the durable
// provenance path from the run configuration through the user-turn tree entry.
// History flattening is covered by conversation's provenance round-trip test.
func TestAppendInboundUserEntryPersistsImplementationPhase(t *testing.T) {
	conv := conversation.CreateConversation("implementation-phase", "sys", "model")

	entry := appendInboundUserEntry(conv, &types.RunOptions{
		Prompt:              "expanded implementation instructions",
		ImplementationPhase: true,
	})
	if entry == nil {
		t.Fatal("appendInboundUserEntry returned nil entry")
	}

	message, ok := entry.Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data = %T, want conversation.MessageData", entry.Data)
	}
	if !message.ImplementationPhase {
		t.Fatal("MessageData.ImplementationPhase = false, want true")
	}
}
