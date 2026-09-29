package session

// SessionInfo describes a session in the list response.
type SessionInfo struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ToolCount      int    `json:"toolCount"`
	ConversationID string `json:"conversationId,omitempty"`
	ExtensionName  string `json:"extensionName,omitempty"`
	// PrincipalSubject is the session's stamped principal subject, when one
	// was supplied on start_session. Empty for a session nobody attributed
	// -- the "unowned" case list_sessions.includeUnowned surfaces.
	PrincipalSubject string `json:"principalSubject,omitempty"`
}
