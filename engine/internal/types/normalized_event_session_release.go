package types

// SessionReleasedEvent reports that the engine released a session on its own,
// without a stop_session command: the session stayed quiescent past its idle
// limit, or an abort arrived while it had no work. The session key no longer
// names a live session; its conversation stays on disk and the key's binding
// survives, so a start_session for the same key resumes it. A client-issued
// stop_session never emits this event.
type SessionReleasedEvent struct {
	// Reason is the release reason the session_before_release hook was
	// offered ("idle_timeout", "idle_abort"). New values may be added.
	Reason string `json:"reason"`
	// ConversationID is the conversation the session was bound to.
	ConversationID string `json:"conversationId,omitempty"`
}

func (SessionReleasedEvent) eventType() string { return EventSessionReleased }
