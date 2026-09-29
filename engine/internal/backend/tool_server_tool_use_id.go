package backend

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/utils"
)

// mcpToolUseIDMetaKey is the `_meta` key a delegated Claude Code CLI attaches to
// every tools/call it sends, carrying the model's tool-use ID for that call.
const mcpToolUseIDMetaKey = "claudecode/toolUseId"

// toolUseIDFromMeta returns the model tool-use ID a client attached to an MCP
// tools/call, or "" when the client sent none.
func toolUseIDFromMeta(params *mcp.CallToolParamsRaw) string {
	if params == nil || params.Meta == nil {
		return ""
	}
	id, _ := params.Meta[mcpToolUseIDMetaKey].(string) //nolint:errcheck // absent or non-string means the client sent no tool-use ID
	return id
}

// stampToolUseID puts the calling model's tool-use ID on the handler context,
// so a background task the tool starts is recorded against the transcript tool
// row that started it. The engine's own runloop stamps the same value from the
// tool_use block; a call arriving over MCP carries it only in `_meta`.
func stampToolUseID(ctx context.Context, name string, params *mcp.CallToolParamsRaw) context.Context {
	toolUseID := toolUseIDFromMeta(params)
	if toolUseID == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tools/call carries no tool-use id; background work started by it cannot be tied to its tool row", map[string]any{"name": name})
		return ctx
	}
	utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tools/call tool-use id stamped", map[string]any{"name": name, "tool_use_id": toolUseID})
	return tools.WithBackgroundToolID(ctx, toolUseID)
}
