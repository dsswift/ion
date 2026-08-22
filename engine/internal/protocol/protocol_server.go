package protocol

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Server -> Client ───

// ServerEvent carries a session event broadcast to all clients.
type ServerEvent struct {
	Key   string               `json:"key"`
	Event types.RawEngineEvent `json:"event"`
}

// ServerResult carries a response to a request-id bearing command.
type ServerResult struct {
	Cmd       string `json:"cmd"`
	RequestID string `json:"requestId"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Data      any    `json:"data,omitempty"`
	// NewKey is set only for fork_session responses (top-level, not wrapped in data).
	NewKey string `json:"newKey,omitempty"`
}

// SessionInfo is one entry in the session list response.
type SessionInfo struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ToolCount      int    `json:"toolCount"`
	ConversationID string `json:"conversationId,omitempty"`
}

// ServerSessionList carries the list_sessions response.
type ServerSessionList struct {
	Cmd      string        `json:"cmd"`
	Sessions []SessionInfo `json:"sessions"`
}

// ResolveExtensions merges the legacy ExtensionDir field with the new Extensions
// list. If Extensions is set, it takes precedence. If only ExtensionDir is set,
// it is wrapped into a single-element slice. Returns nil if neither is set.
func (c *ClientCommand) ResolveExtensions() []string {
	if len(c.Extensions) > 0 {
		return c.Extensions
	}
	if c.ExtensionDir != "" {
		return []string{c.ExtensionDir}
	}
	return nil
}

// SerializeServerEvent serializes a session event as NDJSON.
func SerializeServerEvent(key string, event types.RawEngineEvent) string {
	msg := ServerEvent{Key: key, Event: event}
	b, _ := json.Marshal(msg) //nolint:errcheck // marshal of a local struct
	return string(b) + "\n"
}

// SerializeServerResult serializes a result message as NDJSON.
func SerializeServerResult(msg ServerResult) string {
	msg.Cmd = "result"
	b, _ := json.Marshal(msg) //nolint:errcheck // marshal of a local struct
	return string(b) + "\n"
}

// SerializeServerSessionList serializes a session list message as NDJSON.
func SerializeServerSessionList(sessions []SessionInfo) string {
	msg := ServerSessionList{Cmd: "session_list", Sessions: sessions}
	b, _ := json.Marshal(msg) //nolint:errcheck // marshal of a local struct
	return string(b) + "\n"
}
