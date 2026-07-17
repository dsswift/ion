package plugins

import (
	"encoding/json"
	"strings"
)

// ParseHookOutput parses stdout from a plugin hook command and extracts the
// additionalContext to inject. Matches Claude Code's hook output protocol:
//   - Plain text → inject as-is
//   - {"hookSpecificOutput":{"additionalContext":"..."}} → extract additionalContext
//   - {"decision":"block","reason":"..."} → log intent, return "" (MVP: no blocking)
//   - Empty → ""
func ParseHookOutput(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}

	// Try JSON parse.
	var envelope struct {
		HookSpecificOutput *struct {
			AdditionalContext string `json:"additionalContext"`
		} `json:"hookSpecificOutput"`
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		// Not JSON — treat as plain text.
		return raw
	}
	if envelope.HookSpecificOutput != nil {
		return envelope.HookSpecificOutput.AdditionalContext
	}
	// block decision: MVP ignores blocking.
	return ""
}
