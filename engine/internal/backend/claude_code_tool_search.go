package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// toolSearchName is the tool both backends use to load a deferred tool: the
// Claude Code CLI's own, and the API backend's engine tool of the same name.
const toolSearchName = "ToolSearch"

// claudeToolSearchEnvKey is the Claude Code CLI's tool-search switch.
const claudeToolSearchEnvKey = "ENABLE_TOOL_SEARCH"

// claudeToolSearchEnv returns env with the CLI's tool-search switch set from
// the configured mode (EngineRuntimeConfig.ToolSearch.Mode). With no mode
// configured, or one that does not parse, env is returned unchanged and the
// CLI keeps its own default, which defers MCP tools. Every branch logs.
func claudeToolSearchEnv(env []string, rawMode, requestID string) []string {
	mode, err := types.ParseToolSearchMode(rawMode)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.claude_code", "tool search mode invalid; leaving the cli default", map[string]any{
			"run_id": requestID, "mode": rawMode, "error": err.Error(),
		})
		return env
	}
	value, set := mode.ClaudeCodeEnv()
	if !set {
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "tool search left to the cli default", map[string]any{
			"run_id": requestID,
		})
		return env
	}
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "tool search mode set for the cli", map[string]any{
		"run_id": requestID, "mode": mode.String(), "env": claudeToolSearchEnvKey + "=" + value,
	})
	return append(env, claudeToolSearchEnvKey+"="+value)
}
