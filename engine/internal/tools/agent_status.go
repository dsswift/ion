package tools

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AgentStatusToolName is the read-only companion to AgentToolName. Agent starts
// a new dispatch; AgentStatus only reads dispatches that already exist.
const AgentStatusToolName = "AgentStatus"

// AgentStatusEntry is the model-facing snapshot of one live agent dispatch.
// Session code adapts the authoritative DispatchRegistry snapshot into this
// tool-owned type so the tools package stays independent of session mechanics.
type AgentStatusEntry struct {
	DispatchID          string                `json:"dispatchId"`
	Name                string                `json:"name"`
	Status              string                `json:"status"`
	ParentDispatchID    string                `json:"parentDispatchId,omitempty"`
	Depth               int                   `json:"depth"`
	StartedAt           string                `json:"startedAt"`
	ElapsedMs           int64                 `json:"elapsedMs"`
	ToolCount           int                   `json:"toolCount"`
	LastWork            string                `json:"lastWork,omitempty"`
	LastActivityMs      int64                 `json:"lastActivityMs"`
	ChildConversationID string                `json:"childConversationId,omitempty"`
	WaitingOn           *AgentStatusWaitingOn `json:"waitingOn,omitempty"`
}

// AgentStatusWaitingOn identifies the exact work holding a suspended dispatch.
type AgentStatusWaitingOn struct {
	TaskIDs          []string `json:"taskIds,omitempty"`
	ChildDispatchIDs []string `json:"childDispatchIds,omitempty"`
}

// AgentStatusGetter returns the complete active dispatch snapshot for one
// session. Terminal dispatches are absent because the registry removes them.
type AgentStatusGetter func() []AgentStatusEntry

type agentStatusGetterKey struct{}

// WithAgentStatusGetter adds the session's read-only dispatch snapshot getter to
// a tool execution context.
func WithAgentStatusGetter(ctx context.Context, getter AgentStatusGetter) context.Context {
	return context.WithValue(ctx, agentStatusGetterKey{}, getter)
}

func agentStatusGetterFromContext(ctx context.Context) AgentStatusGetter {
	getter, _ := ctx.Value(agentStatusGetterKey{}).(AgentStatusGetter) //nolint:errcheck // absent means unavailable
	return getter
}

// AgentStatusTool returns the non-mutating live dispatch query tool.
func AgentStatusTool() *types.ToolDef {
	return &types.ToolDef{
		Name: AgentStatusToolName,
		Description: "Inspect agent dispatches that already exist. This read-only call never creates, steers, stops, or waits for an agent. " +
			"Omit dispatch_id to list all active dispatches; provide an exact dispatch ID to inspect one. Completed agents are delivered automatically and no longer appear here. Never use Poll to wait for Agent or dispatch completion.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"dispatch_id": map[string]any{"type": "string", "description": "Optional exact dispatch ID returned by Agent"},
			},
		},
		PlanModeSafe: true,
		Execute:      executeAgentStatus,
	}
}

func executeAgentStatus(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	dispatchID, ok := input["dispatch_id"].(string)
	if input["dispatch_id"] != nil && !ok {
		utils.LogWithFields(utils.LevelWarn, "tools.agent_status", "agent status query rejected", map[string]any{"reason": "dispatch_id_not_string"})
		return &types.ToolResult{Content: "Error: dispatch_id must be a string", IsError: true}, nil
	}

	getter := agentStatusGetterFromContext(ctx)
	if getter == nil {
		utils.LogWithFields(utils.LevelWarn, "tools.agent_status", "agent status query unavailable", map[string]any{"dispatch_id": dispatchID})
		return &types.ToolResult{Content: "Agent status is unavailable for this run", IsError: true}, nil
	}

	utils.LogWithFields(utils.LevelInfo, "tools.agent_status", "agent status query started", map[string]any{"dispatch_id": dispatchID})
	entries := getter()
	sort.Slice(entries, func(i, j int) bool { return entries[i].DispatchID < entries[j].DispatchID })

	if dispatchID != "" {
		for _, entry := range entries {
			if entry.DispatchID == dispatchID {
				return marshalAgentStatus([]AgentStatusEntry{entry}, dispatchID)
			}
		}
		utils.LogWithFields(utils.LevelInfo, "tools.agent_status", "agent status dispatch not found", map[string]any{"dispatch_id": dispatchID, "active_count": len(entries)})
		return &types.ToolResult{Content: "No active agent dispatch found with ID " + dispatchID}, nil
	}

	return marshalAgentStatus(entries, "")
}

func marshalAgentStatus(entries []AgentStatusEntry, dispatchID string) (*types.ToolResult, error) {
	if len(entries) == 0 {
		utils.LogWithFields(utils.LevelInfo, "tools.agent_status", "agent status query completed", map[string]any{"dispatch_id": dispatchID, "active_count": 0})
		return &types.ToolResult{Content: "No active agent dispatches."}, nil
	}
	data, err := json.MarshalIndent(struct {
		Dispatches []AgentStatusEntry `json:"dispatches"`
	}{Dispatches: entries}, "", "  ")
	if err != nil {
		utils.LogWithFields(utils.LevelError, "tools.agent_status", "agent status result encode failed", map[string]any{"dispatch_id": dispatchID, "active_count": len(entries), "error": err.Error()})
		return &types.ToolResult{Content: "Error: failed to encode agent status", IsError: true}, nil
	}
	utils.LogWithFields(utils.LevelInfo, "tools.agent_status", "agent status query completed", map[string]any{"dispatch_id": dispatchID, "active_count": len(entries)})
	return &types.ToolResult{Content: string(data)}, nil
}
