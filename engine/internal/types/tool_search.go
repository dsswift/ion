package types

import (
	"fmt"
	"strconv"
	"strings"
)

// ToolSearchConfig selects how a run loads deferrable tools: MCP server tools
// and extension tools that are not marked always-load. A deferred tool reaches
// the model by name only; the model looks up its definition with ToolSearch
// when a task needs it. One setting governs every backend: the claude-code
// backend passes it to the CLI as ENABLE_TOOL_SEARCH, and the API backend
// applies it to the tool list it sends. See docs/tools/tool-search.md.
type ToolSearchConfig struct {
	// Mode is "on" (defer every deferrable tool), "off" (load every tool
	// upfront), "auto" (defer once deferrable definitions reach 10% of the
	// model's context window), or "auto:N" (the same at N percent, 0-100).
	// Empty leaves each backend's default: the CLI's own default on
	// claude-code, "auto" on the API backend.
	Mode string `json:"mode,omitempty"`
}

// ToolSearchKind is the parsed form of ToolSearchConfig.Mode.
type ToolSearchKind int

const (
	// ToolSearchDefault means no mode was configured.
	ToolSearchDefault ToolSearchKind = iota
	ToolSearchOn
	ToolSearchOff
	ToolSearchAuto
)

// DefaultToolSearchPercent is the "auto" threshold: deferrable definitions at
// or above this share of the context window turn deferral on.
const DefaultToolSearchPercent = 10

// ToolSearchMode is a parsed tool-search setting.
type ToolSearchMode struct {
	Kind ToolSearchKind
	// Percent is the "auto" threshold. Zero for every other kind.
	Percent int
}

// ParseToolSearchMode reads a ToolSearchConfig.Mode value. Empty parses to
// ToolSearchDefault; anything unrecognized is an error naming the value.
func ParseToolSearchMode(raw string) (ToolSearchMode, error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "":
		return ToolSearchMode{Kind: ToolSearchDefault}, nil
	case "on", "true":
		return ToolSearchMode{Kind: ToolSearchOn}, nil
	case "off", "false":
		return ToolSearchMode{Kind: ToolSearchOff}, nil
	case "auto":
		return ToolSearchMode{Kind: ToolSearchAuto, Percent: DefaultToolSearchPercent}, nil
	}
	if rest, ok := strings.CutPrefix(value, "auto:"); ok {
		n, err := strconv.Atoi(rest)
		if err != nil || n < 0 || n > 100 {
			return ToolSearchMode{}, fmt.Errorf("tool search mode %q: the auto threshold is a whole percent from 0 to 100", raw)
		}
		return ToolSearchMode{Kind: ToolSearchAuto, Percent: n}, nil
	}
	return ToolSearchMode{}, fmt.Errorf("tool search mode %q: use on, off, auto, or auto:N", raw)
}

// ClaudeCodeEnv is the ENABLE_TOOL_SEARCH value the Claude Code CLI takes for
// this mode, and whether to set it. The default sets nothing, so the CLI keeps
// its own default.
func (m ToolSearchMode) ClaudeCodeEnv() (string, bool) {
	switch m.Kind {
	case ToolSearchOn:
		return "true", true
	case ToolSearchOff:
		return "false", true
	case ToolSearchAuto:
		return "auto:" + strconv.Itoa(m.Percent), true
	}
	return "", false
}

// String is the canonical config spelling, for logs.
func (m ToolSearchMode) String() string {
	switch m.Kind {
	case ToolSearchOn:
		return "on"
	case ToolSearchOff:
		return "off"
	case ToolSearchAuto:
		return "auto:" + strconv.Itoa(m.Percent)
	}
	return "default"
}
