package extension

// BeforeConversationEventInfo is the read-only payload for the
// before_conversation_event hook. EventName is one of the conversation.*
// event name constants (internal/telemetry). The correlation fields mirror
// whatever the emitting event's own ctx map carried — empty when the
// underlying run has no value for that dimension (e.g. DispatchID is empty
// for a root conversation). Split into its own file (rather than living in
// sdk_hook_types.go) to keep that file under the 800-line file-size cap.
type BeforeConversationEventInfo struct {
	EventName      string `json:"eventName"`
	ConversationID string `json:"conversationId,omitempty"`
	RunID          string `json:"runId,omitempty"`
	DispatchID     string `json:"dispatchId,omitempty"`
	TraceID        string `json:"traceId,omitempty"`
}
