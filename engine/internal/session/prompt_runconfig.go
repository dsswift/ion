package session

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// buildRunConfig assembles the per-run RunConfig that travels with the run on
// the API backend. Each session's hooks/perm engine/external tools/agent
// spawner live on the run, never on shared backend state.
func (m *Manager) buildRunConfig(
	s *engineSession,
	key string,
	requestID string,
	apiBackend *backend.ApiBackend,
	extGroup *extension.ExtensionGroup,
	skipExtensions bool,
	permEng *permissions.Engine,
	telemCollector *telemetry.Collector,
	mcpConns []*mcp.Connection,
	currentModel string,
) *backend.RunConfig {
	runCfg := &backend.RunConfig{}

	if permEng != nil {
		runCfg.PermEngine = permEng
	}
	if m.config != nil && m.config.Security != nil {
		runCfg.SecurityCfg = m.config.Security
	}

	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
		m.wireExtensionHooks(s, key, requestID, apiBackend, extGroup, runCfg)
	}

	if telemCollector != nil {
		runCfg.Telemetry = &telemetryAdapter{c: telemCollector}
	}

	m.wireExternalTools(s, key, extGroup, mcpConns, runCfg)
	m.wireAgentSpawner(s, key, currentModel, runCfg)
	return runCfg
}

// wireExtensionHooks wires per-run extension hook callbacks into runCfg.Hooks.
func (m *Manager) wireExtensionHooks(s *engineSession, key string, requestID string, apiBackend *backend.ApiBackend, extGroup *extension.ExtensionGroup, runCfg *backend.RunConfig) {
	capturedRequestID := requestID
	ctx := m.newExtContext(s, key)
	ctx.GetContextUsage = func() *extension.ContextUsage {
		usage := apiBackend.GetContextUsage(capturedRequestID)
		if usage == nil {
			return nil
		}
		return &extension.ContextUsage{
			Percent: usage.Percent,
			Tokens:  usage.Tokens,
		}
	}

	capturedEnterprise := func() *types.EnterpriseConfig {
		if m.config != nil {
			return m.config.Enterprise
		}
		return nil
	}()
	runCfg.Hooks.OnToolCall = func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
		// G07: Enterprise tool restriction check
		if capturedEnterprise != nil && !ionconfig.IsToolAllowed(info.ToolName, capturedEnterprise) {
			return &backend.ToolCallResult{Block: true, Reason: "tool blocked by enterprise policy"}, nil
		}
		result, err := extGroup.FireToolCall(ctx, extension.ToolCallInfo{
			ToolName: info.ToolName,
			ToolID:   info.ToolID,
			Input:    info.Input,
		})
		if err != nil {
			return nil, err
		}
		if result != nil && result.Block {
			return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
		}
		return nil, nil
	}

	runCfg.Hooks.OnPerToolHook = func(toolName string, info interface{}, phase string) (interface{}, error) {
		if phase == "before" {
			return extGroup.FirePerToolCall(ctx, toolName, info)
		}
		return extGroup.FirePerToolResult(ctx, toolName, info)
	}

	runCfg.Hooks.OnTurnStart = func(_ string, turnNum int) {
		extGroup.FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
	}
	runCfg.Hooks.OnTurnEnd = func(_ string, turnNum int) {
		extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
	}

	runCfg.Hooks.OnBeforePrompt = func(_ string, prompt string) (string, string) {
		rewritten, sysPrompt, _ := extGroup.FireBeforePrompt(ctx, prompt)
		return rewritten, sysPrompt
	}

	runCfg.Hooks.OnPlanModePrompt = func(planFilePath string) (string, []string) {
		return extGroup.FirePlanModePrompt(ctx, planFilePath)
	}

	runCfg.Hooks.OnSessionBeforeCompact = func(_ string) bool {
		cancel, _ := extGroup.FireSessionBeforeCompact(ctx, extension.CompactionInfo{})
		return cancel
	}
	runCfg.Hooks.OnSessionCompact = func(_ string, info interface{}) {
		if ci, ok := info.(map[string]interface{}); ok {
			extGroup.FireSessionCompact(ctx, extension.CompactionInfo{
				Strategy:       fmt.Sprintf("%v", ci["strategy"]),
				MessagesBefore: toInt(ci["messagesBefore"]),
				MessagesAfter:  toInt(ci["messagesAfter"]),
			})
		}
	}

	runCfg.Hooks.OnPermissionRequest = func(_ string, info interface{}) {
		if pi, ok := info.(map[string]interface{}); ok {
			req := extension.PermissionRequestInfo{
				ToolName: fmt.Sprintf("%v", pi["tool_name"]),
				Input:    toStringMap(pi["input"]),
				Decision: fmt.Sprintf("%v", pi["decision"]),
			}
			if t, ok := pi["tier"].(string); ok {
				req.Tier = t
			}
			extGroup.FirePermissionRequest(ctx, req)
		}
	}
	runCfg.Hooks.OnPermissionDenied = func(_ string, info interface{}) {
		if pi, ok := info.(map[string]interface{}); ok {
			extGroup.FirePermissionDenied(ctx, extension.PermissionDeniedInfo{
				ToolName: fmt.Sprintf("%v", pi["tool_name"]),
				Input:    toStringMap(pi["input"]),
				Reason:   fmt.Sprintf("%v", pi["reason"]),
			})
		}
	}

	runCfg.Hooks.OnPermissionClassify = func(toolName string, input map[string]interface{}) string {
		return extGroup.FirePermissionClassify(ctx, extension.PermissionClassifyInfo{
			ToolName: toolName,
			Input:    input,
		})
	}

	runCfg.Hooks.OnFileChanged = func(_ string, path string, action string) {
		extGroup.FireFileChanged(ctx, extension.FileChangedInfo{Path: path, Action: action})
	}
}

// wireExternalTools attaches MCP and extension-registered tools to the run config.
func (m *Manager) wireExternalTools(s *engineSession, key string, extGroup *extension.ExtensionGroup, mcpConns []*mcp.Connection, runCfg *backend.RunConfig) {
	var combinedToolDefs []types.LlmToolDef
	var mcpRouter func(string, map[string]interface{}) (string, bool, error)

	if len(mcpConns) > 0 {
		for _, conn := range mcpConns {
			for _, tool := range conn.Tools() {
				combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
					Name:        "mcp__" + conn.Name() + "__" + tool.Name,
					Description: tool.Description,
					InputSchema: tool.InputSchema,
				})
			}
		}
		mcpRouter = func(fullName string, input map[string]interface{}) (string, bool, error) {
			parts := strings.SplitN(fullName, "__", 3)
			if len(parts) != 3 {
				return "", true, fmt.Errorf("invalid MCP tool name: %s", fullName)
			}
			serverName := parts[1]
			toolName := parts[2]
			for _, conn := range mcpConns {
				if conn.Name() == serverName {
					content, err := conn.CallTool(toolName, input)
					if err != nil {
						return "", true, err
					}
					return content, false, nil
				}
			}
			return "", true, fmt.Errorf("MCP server %q not connected", serverName)
		}
	}

	if extGroup != nil && !extGroup.IsEmpty() {
		extTools := extGroup.Tools()
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: wiring %d extension tools", key, len(extTools)))
		for _, tool := range extTools {
			utils.Log("Session", fmt.Sprintf("SendPrompt[%s]:   tool: %s", key, tool.Name))
			combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
				Name:        tool.Name,
				Description: tool.Description,
				InputSchema: tool.Parameters,
			})
		}
	} else {
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: no extension tools (extGroup=%v)", key, extGroup != nil))
	}

	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: total external tools: %d", key, len(combinedToolDefs)))
	if len(combinedToolDefs) == 0 {
		return
	}
	capturedExtGroup := extGroup
	runCfg.ExternalTools = combinedToolDefs
	runCfg.McpToolRouter = func(name string, input map[string]interface{}) (string, bool, error) {
		if mcpRouter != nil && strings.HasPrefix(name, "mcp__") {
			return mcpRouter(name, input)
		}
		if capturedExtGroup != nil {
			for _, tool := range capturedExtGroup.Tools() {
				if tool.Name == name {
					ctx := m.newExtContext(s, key)
					result, err := tool.Execute(input, ctx)
					if err != nil {
						return err.Error(), true, nil
					}
					if result == nil {
						return "", false, nil
					}
					return result.Content, result.IsError, nil
				}
			}
		}
		return "", true, fmt.Errorf("external tool %q not found", name)
	}
}
