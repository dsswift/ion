package extension

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const maxDynamicTools = 256
const maxDynamicToolSnapshotBytes = 1 << 20

type toolRegistrySnapshot struct {
	Revision int64              `json:"revision"`
	Tools    []toolRegistryTool `json:"tools"`
}

type toolRegistryTool struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Parameters   map[string]any `json:"parameters"`
	PlanModeSafe bool           `json:"planModeSafe,omitempty"`
}

// hostToolRegistry keeps the accepted subprocess declaration as one atomic snapshot.
type hostToolRegistry struct {
	mu       sync.RWMutex
	revision int64
	tools    map[string]toolRegistryTool
}

func (h *Host) initToolRegistry(tools []toolRegistryTool) error {
	return h.applyToolSnapshot(toolRegistrySnapshot{Revision: 0, Tools: tools}, true)
}

func (h *Host) applyToolSnapshot(snapshot toolRegistrySnapshot, initial bool) error {
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		return fmt.Errorf("marshal tool snapshot: %w", err)
	}
	if len(encoded) > maxDynamicToolSnapshotBytes {
		return fmt.Errorf("tool snapshot exceeds %d bytes", maxDynamicToolSnapshotBytes)
	}
	if snapshot.Revision < 0 {
		return fmt.Errorf("tool snapshot revision must be non-negative")
	}
	if len(snapshot.Tools) > maxDynamicTools {
		return fmt.Errorf("tool snapshot exceeds %d tools", maxDynamicTools)
	}
	seen := make(map[string]struct{}, len(snapshot.Tools))
	decls := make(map[string]toolRegistryTool, len(snapshot.Tools))
	for _, tool := range snapshot.Tools {
		if strings.TrimSpace(tool.Name) == "" || strings.TrimSpace(tool.Description) == "" {
			return fmt.Errorf("tool name and description are required")
		}
		if _, ok := seen[tool.Name]; ok {
			return fmt.Errorf("duplicate tool %q", tool.Name)
		}
		seen[tool.Name] = struct{}{}
		if tool.Parameters == nil || tool.Parameters["type"] != "object" {
			return fmt.Errorf("tool %q parameters must be a JSON Schema object", tool.Name)
		}
		decls[tool.Name] = tool
	}
	if h.toolRegistry == nil {
		h.toolRegistry = &hostToolRegistry{tools: make(map[string]toolRegistryTool)}
	}
	h.toolRegistry.mu.Lock()
	if !initial && snapshot.Revision <= h.toolRegistry.revision {
		h.toolRegistry.mu.Unlock()
		return fmt.Errorf("stale tool snapshot revision %d (accepted %d)", snapshot.Revision, h.toolRegistry.revision)
	}
	h.toolRegistry.revision = snapshot.Revision
	h.toolRegistry.tools = decls
	h.toolRegistry.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "extension.tool_registry", "accepted tool snapshot", map[string]any{"extension": h.name_(), "revision": snapshot.Revision, "tool_count": len(decls)})
	return nil
}

func (h *Host) hasAcceptedTool(name string) bool {
	if h.toolRegistry == nil {
		return false
	}
	h.toolRegistry.mu.RLock()
	defer h.toolRegistry.mu.RUnlock()
	_, ok := h.toolRegistry.tools[name]
	return ok
}

func (h *Host) ToolRegistryRevision() int64 {
	if h.toolRegistry == nil {
		return 0
	}
	h.toolRegistry.mu.RLock()
	defer h.toolRegistry.mu.RUnlock()
	return h.toolRegistry.revision
}

func (h *Host) rpcToolRegistrySnapshot(_ *Context, id int64, raw []byte) {
	var request toolRegistrySnapshot
	if err := json.Unmarshal(raw, &request); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid tool snapshot: " + err.Error()})
		return
	}
	if err := h.applyToolSnapshot(request, false); err != nil {
		utils.LogWithFields(utils.LevelWarn, "extension.tool_registry", "rejected tool snapshot", map[string]any{"extension": h.name_(), "revision": request.Revision, "error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	result, err := json.Marshal(struct {
		Revision int64 `json:"revision"`
	}{request.Revision})
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: err.Error()})
		return
	}
	h.sendResponse(id, result, nil)
}

func (h *Host) dynamicToolDefinition(tool toolRegistryTool) ToolDefinition {
	name := tool.Name
	return ToolDefinition{Name: name, Description: tool.Description, Parameters: tool.Parameters, PlanModeSafe: tool.PlanModeSafe,
		Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
			if !h.hasAcceptedTool(name) {
				return &types.ToolResult{Content: fmt.Sprintf("extension tool %q is no longer registered", name), IsError: true}, nil
			}
			raw, err := h.callHook("tool/"+name, ctx, params)
			if err != nil {
				return &types.ToolResult{Content: err.Error(), IsError: true}, nil
			}
			return parseExtensionToolResult(raw, h.name_()), nil
		},
	}
}

func parseExtensionToolResult(raw []byte, name string) *types.ToolResult {
	if len(raw) == 0 || string(raw) == "null" {
		return &types.ToolResult{}
	}
	if result, ok := parseToolResultWithImages(raw, name); ok {
		return result
	}
	var content any
	if err := json.Unmarshal(raw, &content); err != nil {
		return &types.ToolResult{Content: string(raw)}
	}
	formatted, err := json.MarshalIndent(content, "", "  ")
	if err != nil {
		return &types.ToolResult{Content: string(raw)}
	}
	return &types.ToolResult{Content: string(formatted)}
}
