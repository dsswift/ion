package types

// ActivePathChangedEvent reports that a conversation's active path moved to
// another branch of its tree (switch_branch). The model context was rebuilt
// from the new path alone. It is a snapshot of where the path now ends, not a
// delta: a consumer replaces its view of the conversation with the new path.
type ActivePathChangedEvent struct {
	ConversationID string `json:"conversationId"`
	// LeafID is the entry the active path now ends at.
	LeafID string `json:"leafId"`
	// PreviousLeafID is where it ended before; empty when it had no leaf.
	PreviousLeafID string `json:"previousLeafId,omitempty"`
}

func (ActivePathChangedEvent) eventType() string { return EventActivePathChanged }
