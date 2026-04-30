package protocol

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Client -> Server ───

// ClientCommand represents any command sent from a client to the engine server.
// The Cmd field discriminates which fields are relevant.
type ClientCommand struct {
	Cmd          string              `json:"cmd"`
	Key          string              `json:"key,omitempty"`
	Config       *types.EngineConfig `json:"config,omitempty"`
	RequestID    string              `json:"requestId,omitempty"`
	Text         string              `json:"text,omitempty"`
	Model        string              `json:"model,omitempty"`
	MaxTurns     int                 `json:"maxTurns,omitempty"`
	MaxBudgetUsd float64             `json:"maxBudgetUsd,omitempty"`
	AgentName    string              `json:"agentName,omitempty"`
	Subtree      *bool               `json:"subtree,omitempty"`
	Message      string              `json:"message,omitempty"`
	DialogID     string              `json:"dialogId,omitempty"`
	Value        any                 `json:"value,omitempty"`
	Command      string              `json:"command,omitempty"`
	Args         string              `json:"args,omitempty"`
	Prefix       string              `json:"prefix,omitempty"`
	MessageIndex *int                `json:"messageIndex,omitempty"`
	Enabled      *bool               `json:"enabled,omitempty"`
	AllowedTools []string            `json:"allowedTools,omitempty"`
	EntryID      string              `json:"entryId,omitempty"`
	TargetID     string              `json:"targetId,omitempty"`
	ExtensionDir string              `json:"extensionDir,omitempty"`
	Extensions   []string            `json:"extensions,omitempty"`
	NoExtensions bool                `json:"noExtensions,omitempty"`
	QuestionID   string              `json:"questionId,omitempty"`
	OptionID     string              `json:"optionId,omitempty"`
	SessionIDs   []string            `json:"sessionIds,omitempty"`
	Label              string              `json:"label,omitempty"`
	Limit              int                 `json:"limit,omitempty"`
	Offset             int                 `json:"offset,omitempty"`
	AppendSystemPrompt string              `json:"appendSystemPrompt,omitempty"`
	Source             string              `json:"source,omitempty"`

	// elicitation_response: client reply to an engine_elicitation_request event.
	ElicitRequestID string                 `json:"elicitRequestId,omitempty"`
	ElicitResponse  map[string]interface{} `json:"elicitResponse,omitempty"`
	ElicitCancelled bool                   `json:"elicitCancelled,omitempty"`
}

var validCommands = map[string]bool{
	"start_session":   true,
	"send_prompt":     true,
	"abort":           true,
	"abort_agent":     true,
	"steer_agent":     true,
	"dialog_response": true,
	"command":         true,
	"stop_session":    true,
	"stop_by_prefix":  true,
	"list_sessions":   true,
	"fork_session":    true,
	"set_plan_mode":   true,
	"branch":          true,
	"navigate_tree":   true,
	"get_tree":        true,
	"shutdown":               true,
	"permission_response":   true,
	"list_stored_sessions":  true,
	"load_session_history":  true,
	"save_session_label":    true,
	"get_conversation":      true,
	"generate_title":        true,
	"elicitation_response":  true,
	"health":                true,
}

// ParseClientCommand parses a single NDJSON line into a ClientCommand.
// Returns nil if the line is invalid JSON, has an unknown cmd, or is
// missing required fields for the given command type.
func ParseClientCommand(line string) *ClientCommand {
	// First pass: raw map to check field presence and types.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return nil
	}

	cmdRaw, ok := raw["cmd"]
	if !ok {
		return nil
	}
	var cmd string
	if err := json.Unmarshal(cmdRaw, &cmd); err != nil || cmd == "" {
		return nil
	}
	if !validCommands[cmd] {
		return nil
	}

	if !validateRaw(cmd, raw) {
		return nil
	}

	// Second pass: unmarshal into the struct.
	var result ClientCommand
	if err := json.Unmarshal([]byte(line), &result); err != nil {
		return nil
	}
	return &result
}

// ExtractRequestID pulls the requestId from raw JSON without full parsing.
// Used when ParseClientCommand returns nil so error responses can still be matched.
func ExtractRequestID(line string) string {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(line), &raw); err != nil {
		return ""
	}
	v, ok := raw["requestId"]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return ""
	}
	return s
}

// hasString checks that raw[field] exists and is a JSON string.
func hasString(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var s string
	return json.Unmarshal(v, &s) == nil
}

// hasNonEmptyString checks that raw[field] is a non-empty string.
// Mirrors the TS check `!parsed.field` which is falsy for "" and undefined.
func hasNonEmptyString(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return false
	}
	return s != ""
}

// hasNumber checks that raw[field] exists and is a JSON number.
func hasNumber(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var n float64
	return json.Unmarshal(v, &n) == nil
}

// hasBool checks that raw[field] exists and is a JSON boolean.
func hasBool(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var b bool
	return json.Unmarshal(v, &b) == nil
}

// hasArray checks that raw[field] exists and is a JSON array.
func hasArray(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var arr []json.RawMessage
	return json.Unmarshal(v, &arr) == nil
}

// hasObject checks that raw[field] exists and is a JSON object.
func hasObject(raw map[string]json.RawMessage, field string) bool {
	v, ok := raw[field]
	if !ok {
		return false
	}
	var obj map[string]json.RawMessage
	return json.Unmarshal(v, &obj) == nil
}

func validateRaw(cmd string, raw map[string]json.RawMessage) bool {
	switch cmd {
	case "start_session":
		return hasNonEmptyString(raw, "key") && hasObject(raw, "config")
	case "send_prompt":
		return hasNonEmptyString(raw, "key") && hasString(raw, "text")
	case "abort", "stop_session", "get_tree":
		return hasNonEmptyString(raw, "key")
	case "abort_agent":
		return hasNonEmptyString(raw, "key") && hasString(raw, "agentName")
	case "steer_agent":
		return hasNonEmptyString(raw, "key") && hasString(raw, "agentName") && hasString(raw, "message")
	case "stop_by_prefix":
		return hasNonEmptyString(raw, "prefix")
	case "dialog_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "dialogId")
	case "command":
		return hasNonEmptyString(raw, "key") && hasString(raw, "command")
	case "fork_session":
		return hasNonEmptyString(raw, "key") && hasNumber(raw, "messageIndex")
	case "set_plan_mode":
		return hasNonEmptyString(raw, "key") && hasBool(raw, "enabled")
	case "branch":
		return hasNonEmptyString(raw, "key") && hasString(raw, "entryId")
	case "navigate_tree":
		return hasNonEmptyString(raw, "key") && hasString(raw, "targetId")
	case "permission_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "questionId") && hasNonEmptyString(raw, "optionId")
	case "list_sessions", "shutdown", "list_stored_sessions", "health":
		return true
	case "get_conversation":
		return hasNonEmptyString(raw, "key")
	case "load_session_history":
		return hasNonEmptyString(raw, "key") || hasArray(raw, "sessionIds")
	case "save_session_label":
		return hasNonEmptyString(raw, "key") && hasString(raw, "label")
	case "generate_title":
		return hasString(raw, "text")
	case "elicitation_response":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "elicitRequestId")
	}
	return false
}

// ─── Server -> Client ───

// ServerEvent carries a session event broadcast to all clients.
type ServerEvent struct {
	Key   string             `json:"key"`
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
	b, _ := json.Marshal(msg)
	return string(b) + "\n"
}

// SerializeServerResult serializes a result message as NDJSON.
func SerializeServerResult(msg ServerResult) string {
	msg.Cmd = "result"
	b, _ := json.Marshal(msg)
	return string(b) + "\n"
}

// SerializeServerSessionList serializes a session list message as NDJSON.
func SerializeServerSessionList(sessions []SessionInfo) string {
	msg := ServerSessionList{Cmd: "session_list", Sessions: sessions}
	b, _ := json.Marshal(msg)
	return string(b) + "\n"
}
