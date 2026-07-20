package extcontext

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CallToolFromExtension dispatches an extension-initiated tool call through
// the session's tool registry: built-in tools, MCP-registered tools, and
// extension-registered tools (any host in the loaded group).
//
// Permission policy gates the call: deny rules return an error result, "ask"
// decisions auto-deny because extension calls cannot block on user
// elicitation. Per-tool hooks (bash_tool_call, etc.) and permission_request
// are NOT fired — they would re-enter the calling extension and create
// surprising recursion.
//
// Returns (content, isError, err). A non-nil err is reserved for unknown
// tool names so the SDK can surface a Promise rejection on what is almost
// always a programming error. Tool-internal failures resolve as
// (errorMessage, true, nil).
func CallToolFromExtension(ctx context.Context, sa SessionAccessor, toolName string, input map[string]interface{}) (string, bool, error) {
	if input == nil {
		input = map[string]interface{}{}
	}

	// Permission gate.
	decision, reason := sa.PermissionCheck(toolName, input)
	switch decision {
	case "allow":
		// proceed
	case "deny":
		if reason == "" {
			reason = "denied by policy"
		}
		return fmt.Sprintf("Permission denied: %s", reason), true, nil
	case "ask":
		return fmt.Sprintf(
			"Permission requires user approval (rule: %s); extension calls cannot block on elicitation. Configure an explicit allow rule for %q in your permission policy.",
			reason, toolName,
		), true, nil
	case "":
		// No permission engine configured; allow.
	default:
		return fmt.Sprintf("Permission engine returned unknown decision: %q", decision), true, nil
	}

	cwd := sa.WorkingDirectory()

	// 1. Built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent, etc).
	if tools.GetTool(toolName) != nil {
		toolResult, err := tools.ExecuteTool(ctx, toolName, input, cwd)
		if err != nil {
			return "", true, err
		}
		if toolResult == nil {
			return "", false, nil
		}
		return toolResult.Content, toolResult.IsError, nil
	}

	// 2. MCP-registered tools (mcp__server__tool prefix).
	if strings.HasPrefix(toolName, "mcp__") {
		mcpConns := sa.McpConnections()
		parts := strings.SplitN(toolName, "__", 3)
		if len(parts) != 3 {
			return fmt.Sprintf("Invalid MCP tool name: %s", toolName), true, nil
		}
		serverName := parts[1]
		innerName := parts[2]
		for _, conn := range mcpConns {
			if conn.Name() == serverName {
				callCtx, callCancel := context.WithTimeout(ctx, mcp.DefaultCallTimeout)
				content, err := conn.CallTool(callCtx, innerName, input)
				callCancel()
				if err != nil {
					// Log at the call site so an MCP tool failure — which server,
					// which tool — is visible from the logs alone, not only via
					// the error bubbling up to an opaque caller.
					utils.LogWithFields(utils.LevelError, "extcontext", "mcp tool call failed", map[string]any{"serverName": serverName, "toolName": innerName, "error": utils.ErrStr(err)})
					return "", true, err
				}
				return content, false, nil
			}
		}
		utils.LogWithFields(utils.LevelWarn, "extcontext", "mcp server not connected", map[string]any{"serverName": serverName, "toolName": innerName})
		return fmt.Sprintf("MCP server %q not connected", serverName), true, nil
	}

	// 3. Extension-registered tools (any host in the loaded group).
	if eg := sa.ExtGroup(); eg != nil {
		for _, tool := range eg.Tools() {
			if tool.Name == toolName {
				ctx := NewExtContext(sa)
				result, err := tool.Execute(input, ctx)
				if err != nil {
					return "", true, err
				}
				if result == nil {
					return "", false, nil
				}
				return result.Content, result.IsError, nil
			}
		}
	}

	// 4. Unknown — programming error in the calling extension.
	return "", true, fmt.Errorf("unknown tool: %s", toolName)
}
