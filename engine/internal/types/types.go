// Package types defines the wire-compatible Go equivalents of the Ion Engine
// TypeScript types. JSON struct tags match the TypeScript field names exactly.
package types

import "encoding/json"

// RawEngineEvent is a pass-through JSON representation of an engine event.
// Use this when forwarding events without parsing (e.g., socket relay).
type RawEngineEvent = json.RawMessage

// Stream-event payload shapes (InitEvent, StreamEvent, AssistantEvent,
// ResultEvent, UsageData, PermissionEvent, etc. — everything consumed off
// the Anthropic streaming API) live in stream_events.go. Split out so this
// file has headroom for ongoing EngineEvent surface growth.

// --- Message ---

// Message is a single entry in the conversation history.
type Message struct {
	ID               string `json:"id"`
	Role             string `json:"role"`
	Content          string `json:"content"`
	ToolName         string `json:"toolName,omitempty"`
	ToolInput        string `json:"toolInput,omitempty"`
	ToolID           string `json:"toolId,omitempty"`
	ToolStatus       string `json:"toolStatus,omitempty"`
	UserExecuted     bool   `json:"userExecuted,omitempty"`
	AutoExpandResult bool   `json:"autoExpandResult,omitempty"`
	Timestamp        int64  `json:"timestamp"`
}

// --- Engine Types ---

// EngineProfile defines an extension profile for the engine.
type EngineProfile struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

// EngineConfig configures a single engine session.
type EngineConfig struct {
	ProfileID        string          `json:"profileId"`
	Extensions       []string        `json:"extensions"`
	WorkingDirectory string          `json:"workingDirectory"`
	SessionID        string          `json:"sessionId,omitempty"`
	Model            string          `json:"model,omitempty"`
	MaxTokens        int             `json:"maxTokens,omitempty"`
	Thinking         *ThinkingConfig `json:"thinking,omitempty"`
	SystemHint       string          `json:"systemHint,omitempty"`

	// WorkspaceWatchIgnore overrides the engine's default ignore-glob list
	// for the workspace_file_changed watcher. When nil/empty the engine uses
	// its built-in defaults (.git/**, node_modules/**, dist/**, build/**,
	// target/**, .next/**, .nuxt/**, .venv/**, __pycache__/**, .ion/**,
	// .DS_Store, *.swp, *.swo, *.tmp, *~). A non-empty slice REPLACES the
	// defaults entirely -- it does not merge. Patterns use doublestar
	// (forward-slash) syntax and are matched against repo-relative paths.
	WorkspaceWatchIgnore []string `json:"workspaceWatchIgnore,omitempty"`

	// ClaudeCompat enables Claude Code compatibility features such as loading
	// skills from ~/.claude/skills/.
	ClaudeCompat bool `json:"claudeCompat,omitempty"`
}

// ThinkingConfig controls extended thinking for API-backend runs.
type ThinkingConfig struct {
	Enabled      bool `json:"enabled"`
	BudgetTokens int  `json:"budgetTokens,omitempty"`
}

// EngineInstance identifies a running engine instance.
type EngineInstance struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// EnginePaneState tracks the set of engine instances and which is active.
type EnginePaneState struct {
	Instances        []EngineInstance `json:"instances"`
	ActiveInstanceID *string          `json:"activeInstanceId"`
}

// AgentStateUpdate describes the current state of an agent.
type AgentStateUpdate struct {
	Name     string                 `json:"name"`
	ID       string                 `json:"id,omitempty"`
	Status   string                 `json:"status"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// AgentMessage is a single message within an agent's conversation.
type AgentMessage struct {
	Role     string `json:"role"`
	Content  string `json:"content"`
	ToolName string `json:"toolName,omitempty"`
}

// AgentHandle is a process registration handle for per-agent abort/steer.
type AgentHandle struct {
	PID         int
	StdinWrite  func(message string) bool
	ParentAgent string
}

// AgentSpec is an LLM-visible agent definition. Mirrors the markdown
// frontmatter shape (name, description, model, tools, parent, systemPrompt).
// Specs are registered at runtime via Context.RegisterAgentSpec so an
// extension's `capability_match` handler can promote a draft into a live,
// named specialist that the Agent tool can immediately dispatch.
type AgentSpec struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
}

// EngineCommandListing describes a single slash command exposed by a session's
// extensions. Consumers use this to populate a routing-hint cache so they can
// short-circuit local template lookups for command names the extensions own.
// Carried inside engine_command_registry events whose payload is always a
// complete snapshot of the session's current command set (see AGENTS.md
// snapshot-contract rules — consumers REPLACE local state, not merge).
type EngineCommandListing struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// StatusFields are the fields emitted by engine_status events.
type StatusFields struct {
	Label             string             `json:"label"`
	State             string             `json:"state"`
	SessionID         string             `json:"sessionId,omitempty"`
	Team              string             `json:"team,omitempty"`
	Model             string             `json:"model"`
	ContextPercent    int                `json:"contextPercent"`
	ContextWindow     int                `json:"contextWindow"`
	TotalCostUsd      float64            `json:"totalCostUsd,omitempty"`
	PermissionDenials []PermissionDenial `json:"permissionDenials,omitempty"`
	// ExtensionName is a friendly display name broadcast by the extension via
	// ext/emit engine_status. The engine preserves it across its own status
	// transitions so clients can show "Chief of Staff [idle]" instead of a
	// GUID compound key. Empty means no extension name was broadcast.
	ExtensionName string `json:"extensionName,omitempty"`
	// BackgroundAgents is the number of background dispatch agents still running
	// when the parent LLM turn ends. When > 0, the engine is "idle" (the parent
	// isn't running) but background work is in progress. Clients use this to keep
	// the tab status active and the interrupt button visible.
	BackgroundAgents int `json:"backgroundAgents,omitempty"`
}


// MessageEndUsage reports token usage at the end of a message.
type MessageEndUsage struct {
	InputTokens    int     `json:"inputTokens"`
	OutputTokens   int     `json:"outputTokens"`
	ContextPercent int     `json:"contextPercent"`
	Cost           float64 `json:"cost"`
}


// EarlyStopContinueConfig holds the engine-wide defaults for the early-stop
// continuation feature. Lives under `earlyStopContinue` in ~/.ion/engine.json.
// All fields are pointers so the merge layer can tell "not set in this file"
// from "explicitly zero". Resolved against built-in defaults in
// EarlyStopDefaults() before per-run overrides apply.
type EarlyStopContinueConfig struct {
	// Enabled is the global kill switch. When nil, the built-in default
	// (true) wins. Set to false in engine.json to disable the feature for
	// every run on this machine.
	Enabled *bool `json:"enabled,omitempty"`

	// Budget is the global output-token target. Zero means "use default" (8000).
	Budget int `json:"budget,omitempty"`

	// ThresholdPct is the global completion threshold percent. Zero means
	// "use default" (90).
	ThresholdPct int `json:"thresholdPct,omitempty"`

	// MaxContinuations caps the number of continuation nudges per run. Zero
	// means "use default" (3).
	MaxContinuations int `json:"maxContinuations,omitempty"`

	// DiminishingDelta is the per-continuation token delta below which the
	// engine declares diminishing returns. Zero means "use default" (500).
	DiminishingDelta int `json:"diminishingDelta,omitempty"`
}

// EarlyStopDefaults returns the built-in defaults for the early-stop
// continuation feature. Defaults to OFF: the engine provides the mechanism
// (cumulative output-token tracking, before_early_stop_decision /
// early_stop_continued hooks, re-run-turn machinery) but ships no opinion
// about whether to nudge or what text to nudge with. A harness consumer
// must opt in — either through engine.json (`earlyStopContinue.enabled =
// true`) for a config-level toggle, or by wiring a
// before_early_stop_decision handler that returns ForceContinue and a
// ContinueMessage. The numeric tuning knobs (budget, thresholdPct,
// maxContinuations, diminishingDelta) are calibration values that only
// take effect when something higher up the resolution chain has enabled
// the feature; the 8000-token budget matches one substantial multi-step
// turn and harness engineers should retune per agent.
func EarlyStopDefaults() EarlyStopContinueConfig {
	enabled := false
	return EarlyStopContinueConfig{
		Enabled:          &enabled,
		Budget:           8000,
		ThresholdPct:     90,
		MaxContinuations: 3,
		DiminishingDelta: 500,
	}
}

// StoredSessionInfo is metadata for a saved conversation on disk.
type StoredSessionInfo struct {
	SessionID    string  `json:"sessionId"`
	Model        string  `json:"model"`
	CreatedAt    int64   `json:"createdAt"`
	MessageCount int     `json:"messageCount"`
	TotalCost    float64 `json:"totalCost"`
	FirstMessage string  `json:"firstMessage"`
	LastMessage  string  `json:"lastMessage"`
	CustomTitle  string  `json:"customTitle,omitempty"`
}

// SessionMessage is a flattened message for client display.
type SessionMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"toolName,omitempty"`
	ToolID    string `json:"toolId,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Internal  bool   `json:"internal,omitempty"`
}

// PermissionDenialEntry is the wire format for permission denials in ResultEvent.
type PermissionDenialEntry struct {
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
}

// PermissionDenial records a tool invocation that was denied.
// Wire format uses camelCase to match the NormalizedEvent JSON convention.
type PermissionDenial struct {
	ToolName  string         `json:"toolName"`
	ToolUseID string         `json:"toolUseId"`
	ToolInput map[string]any `json:"toolInput,omitempty"`
}

// EnrichedError carries detailed context about a failed run.
type EnrichedError struct {
	Message              string             `json:"message"`
	StderrTail           []string           `json:"stderrTail"`
	StdoutTail           []string           `json:"stdoutTail,omitempty"`
	ExitCode             *int               `json:"exitCode"`
	ElapsedMs            int64              `json:"elapsedMs"`
	ToolCallCount        int                `json:"toolCallCount"`
	SawPermissionRequest bool               `json:"sawPermissionRequest,omitempty"`
	PermissionDenials    []PermissionDenial `json:"permissionDenials,omitempty"`
}
