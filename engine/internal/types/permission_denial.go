// Package types — the permission-denial records a run reports and the
// enriched error that carries them. Split from types.go, which holds the
// session and config types and sits at the file-size cap.
package types

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
