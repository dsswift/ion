package conversation

import "testing"

func TestAddUserMessageWithDeliveryIDs_IsIdempotent(t *testing.T) {
	conv := CreateConversation("delivery-idempotent", "system", "model")
	if added := AddUserMessageWithDeliveryIDs(conv, "child result", "agent_completion", []string{"completion-1"}); !added {
		t.Fatal("first delivery was not added")
	}
	if added := AddUserMessageWithDeliveryIDs(conv, "child result", "agent_completion", []string{"completion-1"}); added {
		t.Fatal("duplicate delivery ID added a second message")
	}
	if len(conv.Messages) != 1 || len(conv.Entries) != 1 {
		t.Fatalf("message/entry count = %d/%d, want 1/1", len(conv.Messages), len(conv.Entries))
	}
	entry, ok := conv.Entries[0].Data.(MessageData)
	if !ok {
		t.Fatalf("entry data = %T, want MessageData", conv.Entries[0].Data)
	}
	if len(entry.DeliveryIDs) != 1 || entry.DeliveryIDs[0] != "completion-1" {
		t.Fatalf("delivery IDs = %v, want [completion-1]", entry.DeliveryIDs)
	}
}

func TestHasDeliveryID_MatchesExisting(t *testing.T) {
	conv := CreateConversation("has-delivery-match", "system", "model")
	AddUserMessageWithDeliveryIDs(conv, "hello", "", []string{"prompt-abc"})

	if !HasDeliveryID(conv, "prompt-abc") {
		t.Fatal("HasDeliveryID should return true for existing ID")
	}
}

func TestHasDeliveryID_NoMatch(t *testing.T) {
	conv := CreateConversation("has-delivery-nomatch", "system", "model")
	AddUserMessageWithDeliveryIDs(conv, "hello", "", []string{"prompt-abc"})

	if HasDeliveryID(conv, "prompt-xyz") {
		t.Fatal("HasDeliveryID should return false for non-existing ID")
	}
}

func TestHasDeliveryID_EmptyID(t *testing.T) {
	conv := CreateConversation("has-delivery-empty", "system", "model")
	AddUserMessageWithDeliveryIDs(conv, "hello", "", []string{"prompt-abc"})

	if HasDeliveryID(conv, "") {
		t.Fatal("HasDeliveryID should return false for empty ID")
	}
}

func TestHasDeliveryID_EmptyConversation(t *testing.T) {
	conv := CreateConversation("has-delivery-empty-conv", "system", "model")

	if HasDeliveryID(conv, "prompt-abc") {
		t.Fatal("HasDeliveryID should return false on empty conversation")
	}
}
