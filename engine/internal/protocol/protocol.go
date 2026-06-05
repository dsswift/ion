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
	Provider           string              `json:"provider,omitempty"`
	Credential         string              `json:"credential,omitempty"`

	// elicitation_response: client reply to an engine_elicitation_request event.
	ElicitRequestID string                 `json:"elicitRequestId,omitempty"`
	ElicitResponse  map[string]interface{} `json:"elicitResponse,omitempty"`
	ElicitCancelled bool                   `json:"elicitCancelled,omitempty"`

	// early_stop_decision_response: client reply to an
	// engine_early_stop_decision_request event. All fields are optional; an
	// empty reply expresses no opinion (engine falls through to its existing
	// merge logic — typically meaning no continuation when nothing supplied
	// a ContinueMessage). Mirrors the extension-side EarlyStopDecisionResult
	// shape; see types.go for the request-event field documentation.
	EarlyStopRequestID            string `json:"earlyStopRequestId,omitempty"`
	EarlyStopForceContinue        *bool  `json:"earlyStopForceContinue,omitempty"`
	EarlyStopOverrideBudget       int    `json:"earlyStopOverrideBudget,omitempty"`
	EarlyStopOverrideThresholdPct int    `json:"earlyStopOverrideThresholdPct,omitempty"`
	EarlyStopContinueMessage      string `json:"earlyStopContinueMessage,omitempty"`

	// list_directory: absolute path to enumerate on the engine's host.
	// Empty or "~" resolves to the engine user's home directory. ShowHidden
	// includes dotfiles in the result.
	Path       string `json:"path,omitempty"`
	ShowHidden bool   `json:"showHidden,omitempty"`

	// send_prompt: pre-encoded image attachments to attach to the user
	// message as native image content blocks. The engine has no opinion on
	// any client-side marker syntax inside Text — clients pass image bytes
	// here and the backend forwards them to the provider via its multimodal
	// content format.
	Attachments []types.ImageAttachment `json:"attachments,omitempty"`

	// send_prompt: when true, the engine maps this onto
	// RunOptions.ImplementationPhase for the dispatched run, which
	// suppresses the EnterPlanMode sentinel-tool injection. Clients set
	// this on the "implement" half of a plan-then-implement flow so the
	// model can't re-propose plan-mode entry against the user's already-
	// approved intent. Optional; defaults to false. See the field comment
	// in engine/internal/types/types.go for the full rationale.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`

	// send_prompt: harness-supplied description prose for the
	// EnterPlanMode sentinel tool that the engine injects during
	// auto-mode runs. When non-empty, the engine forwards this string
	// verbatim as the tool's description to the model. When empty (or
	// omitted), the engine falls back to a one-line neutral default.
	// Per ADR-004, the prose belongs in the harness — the Ion desktop
	// client is the reference implementation and supplies its prose
	// from desktop/src/main/prompt-pipeline.ts; any harness supplies
	// its own. Mirrors RunOptions.EnterPlanModeDescription one-for-one.
	EnterPlanModeDescription string `json:"enterPlanModeDescription,omitempty"`

	// send_prompt: harness-supplied text for the per-turn sparse plan-mode
	// reminder the engine injects every planModeReminderInterval turns.
	// When non-empty, the engine uses this string verbatim instead of
	// buildPlanModeSparseReminder. When empty (or omitted), the engine
	// builds the reminder from the plan file path. Parallel override to
	// EnterPlanModeDescription / RunOptions.PlanModePrompt — same additive
	// omitempty contract. Mirrors RunOptions.PlanModeSparseReminder.
	PlanModeSparseReminder string `json:"planModeSparseReminder,omitempty"`

	// send_prompt: persisted plan file path from the desktop's tab state.
	// When non-empty, the engine restores the session's planFilePath from
	// this value instead of allocating a fresh slug — preserving plan file
	// continuity across desktop restarts. The engine validates that the
	// file exists on disk; if missing it falls back to fresh allocation.
	// Additive optional field; omitted by clients that have no persisted
	// plan file path.
	PlanFilePath string `json:"planFilePath,omitempty"`

	// set_plan_mode: list of bash command prefixes that the engine
	// allows in plan mode. Tri-valued:
	//   - omitted (JSON nil)    → no change to existing allowlist
	//   - []                    → clear; Bash blocked entirely
	//   - ["gh", "git log", ...] → replace allowlist with this set
	// Token-based prefix matching (whitespace-split, exact-token
	// comparison) prevents false positives ("gh" matches "gh pr view"
	// but not "ghost"). Existing clients (omitted or non-empty) keep
	// their prior behavior; the empty-array case is the explicit-clear
	// path. Additive optional field; omitted by clients that do not
	// need to extend the plan-mode bash allowlist.
	PlanModeAllowedBashCommands []string `json:"planModeAllowedBashCommands,omitempty"`

	// send_prompt: per-prompt bash-allowlist additions. Distinct from
	// PlanModeAllowedBashCommands above (which is a SESSION-scoped
	// override carried on set_plan_mode). The additions here are
	// **transient**: the engine unions them with the session allowlist
	// when building the prompt's run-time tool list, then drops them at
	// run end. They never persist on engineSession.planModeAllowedBashCommands.
	//
	// Use case: slash commands whose YAML frontmatter declares an
	// `allowed_bash_commands` list (e.g. `/ion--review-changes` needing
	// `gh pr diff` for that turn only). The harness attaches the
	// frontmatter list here so the engine grants the additional
	// permissions for exactly one run; subsequent prompts in the same
	// session run against the unmodified session allowlist.
	//
	// Set semantics (union with session allowlist, de-duplicated,
	// order-preserved): the engine computes the effective allowlist for
	// the run as session ∪ additions. Duplicates are dropped; the
	// session-side entries win position-wise. Additive optional field;
	// omitted by clients that do not need per-prompt additions. The
	// session allowlist itself is never mutated by this field — that
	// invariant is the entire point of the field's existence.
	BashAllowlistAdditionsForThisPrompt []string `json:"bashAllowlistAdditionsForThisPrompt,omitempty"`

	// Compaction overrides — per-prompt tuning of context compaction behavior.
	CompactTargetPercent  float64 `json:"compactTargetPercent,omitempty"`
	CompactMicroKeepTurns int     `json:"compactMicroKeepTurns,omitempty"`
	CompactEnabled        *bool   `json:"compactEnabled,omitempty"`
	CompactSummaryEnabled *bool   `json:"compactSummaryEnabled,omitempty"`
	CompactMemoryEnabled  *bool   `json:"compactMemoryEnabled,omitempty"`
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
	"early_stop_decision_response": true,
	"health":                true,
	"reconcile_state":       true,
	"migrate_conversation":  true,
	"list_models":           true,
	"store_credential":      true,
	"refresh_models":        true,
	"get_host_info":         true,
	"list_directory":        true,
	// clear_conversation_file: wipes the LLM-visible Messages (and resets
	// LastInputTokens / LastInputTokensMsgCount) on a stored conversation
	// file by sessionId, without requiring a live engine session. Used by
	// consumers that need to reset a conversation file when no in-memory
	// session is running against it (so dispatchClear cannot be used).
	// Non-breaking additive command. Requires key (sessionId).
	"clear_conversation_file": true,
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
	case "early_stop_decision_response":
		// Only key + earlyStopRequestId are required. All response fields
		// are optional; an empty response is a valid "no opinion" reply.
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "earlyStopRequestId")
	case "reconcile_state":
		return hasNonEmptyString(raw, "key")
	case "migrate_conversation":
		return hasNonEmptyString(raw, "key") && hasNonEmptyString(raw, "text") && hasNonEmptyString(raw, "message")
	case "list_models":
		return true
	case "store_credential":
		return hasNonEmptyString(raw, "provider") && hasString(raw, "credential")
	case "refresh_models":
		return true // optional: provider field to refresh a single provider
	case "get_host_info":
		return true
	case "list_directory":
		// path is optional ("" or "~" → engine home); no required fields
		return true
	case "clear_conversation_file":
		// key carries the sessionId (conversationId) to wipe. Required and non-empty.
		return hasNonEmptyString(raw, "key")
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
