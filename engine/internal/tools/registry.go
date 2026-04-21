package tools

import (
	"context"
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

var (
	registry = make(map[string]*types.ToolDef)
	mu       sync.RWMutex
)

// RegisterTool adds or replaces a tool in the registry.
func RegisterTool(t *types.ToolDef) {
	mu.Lock()
	defer mu.Unlock()
	registry[t.Name] = t
}

// UnregisterTool removes a tool from the registry by name.
func UnregisterTool(name string) {
	mu.Lock()
	defer mu.Unlock()
	delete(registry, name)
}

// GetTool returns a tool by name, or nil if not found.
func GetTool(name string) *types.ToolDef {
	mu.RLock()
	defer mu.RUnlock()
	return registry[name]
}

// GetAllTools returns all registered tools.
func GetAllTools() []*types.ToolDef {
	mu.RLock()
	defer mu.RUnlock()
	result := make([]*types.ToolDef, 0, len(registry))
	for _, t := range registry {
		result = append(result, t)
	}
	return result
}

// ExecuteTool finds a tool by name and executes it. Returns an error result
// for unknown tools rather than a Go error.
func ExecuteTool(ctx context.Context, name string, input map[string]any, cwd string) (*types.ToolResult, error) {
	t := GetTool(name)
	if t == nil {
		return &types.ToolResult{Content: fmt.Sprintf("Unknown tool: %s", name), IsError: true}, nil
	}
	return t.Execute(ctx, input, cwd)
}

// GetToolDefs returns all tools in the LLM API format (name, description, input_schema).
func GetToolDefs() []types.LlmToolDef {
	mu.RLock()
	defer mu.RUnlock()
	defs := make([]types.LlmToolDef, 0, len(registry))
	for _, t := range registry {
		defs = append(defs, types.LlmToolDef{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	return defs
}

func init() {
	registerBuiltinTools()
}

func registerBuiltinTools() {
	RegisterTool(ReadTool())
	RegisterTool(WriteTool())
	RegisterTool(EditTool())
	RegisterTool(BashTool())
	RegisterTool(GrepTool())
	RegisterTool(GlobTool())
	RegisterTool(AgentTool())
	RegisterTool(WebFetchTool())
	RegisterTool(WebSearchTool())
	// Task tools (TaskCreate, TaskList, TaskGet, TaskStop) are optional.
	// Call RegisterTaskTools() from harness code to opt in.
	RegisterTool(NotebookTool())
	RegisterTool(LspTool())
	RegisterTool(SkillTool())
	RegisterTool(ListMcpResourcesTool())
	RegisterTool(ReadMcpResourceTool())
	// ExitPlanMode is NOT registered globally. It is injected by api_backend
	// only when PlanMode is active, and intercepted there before execution.
}
