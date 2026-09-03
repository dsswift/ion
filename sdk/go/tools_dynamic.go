package ion

import (
	"context"
	"fmt"
	"sort"
)

// ToolRegistrySnapshot is the complete dynamic tool declaration sent to Ion.
type ToolRegistrySnapshot struct {
	Revision int64             `json:"revision"`
	Tools    []ToolDeclaration `json:"tools"`
}

// ToolDeclaration is the wire-safe portion of ToolDef.
type ToolDeclaration struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	Parameters   map[string]any `json:"parameters"`
	PlanModeSafe bool           `json:"planModeSafe,omitempty"`
}

// DeregisterTool removes a locally registered tool. It returns whether it existed.
func (s *SDK) DeregisterTool(name string) bool {
	s.mu.Lock()
	_, exists := s.tools[name]
	if exists {
		delete(s.tools, name)
		if s.initialized() {
			s.toolRevision++
		}
	}
	s.mu.Unlock()
	return exists
}

// SyncTools sends the current complete tool declaration and returns the accepted revision.
func (s *SDK) SyncTools(ctx context.Context) (int64, error) {
	s.mu.RLock()
	snapshot := ToolRegistrySnapshot{Revision: s.toolRevision, Tools: make([]ToolDeclaration, 0, len(s.tools))}
	for _, tool := range s.tools {
		snapshot.Tools = append(snapshot.Tools, ToolDeclaration{Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters, PlanModeSafe: tool.PlanModeSafe})
	}
	s.mu.RUnlock()
	sort.Slice(snapshot.Tools, func(i, j int) bool { return snapshot.Tools[i].Name < snapshot.Tools[j].Name })
	if !s.initialized() {
		return snapshot.Revision, nil
	}
	var accepted struct {
		Revision int64 `json:"revision"`
	}
	if err := s.call(ctx, "ext/tool_registry_snapshot", snapshot, &accepted); err != nil {
		return 0, fmt.Errorf("sync tools: %w", err)
	}
	return accepted.Revision, nil
}
