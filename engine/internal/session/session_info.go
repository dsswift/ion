package session

// SessionInfo describes a session in the list response.
type SessionInfo struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ToolCount      int    `json:"toolCount"`
	ConversationID string `json:"conversationId,omitempty"`
	ExtensionName  string `json:"extensionName,omitempty"`
}
