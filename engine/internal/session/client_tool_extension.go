package session

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// callClientToolFromExtension resolves a declared client tool for an SDK
// ctx.callTool invocation. It captures the current session declaration and
// uses the same bounded result transport as model-originated calls.
func (m *Manager) callClientToolFromExtension(ctx context.Context, key, name string, input map[string]interface{}) (*types.ToolResult, bool) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.config.ToolGate == nil || !s.config.ToolGate.Enabled {
		m.mu.RUnlock()
		return nil, false
	}
	gateCfg := s.config.ToolGate
	var def types.ClientToolDef
	for _, candidate := range gateCfg.ClientTools {
		if candidate.Name == name {
			def = candidate
			break
		}
	}
	cwd := s.config.WorkingDirectory
	m.mu.RUnlock()
	if def.Name == "" {
		return nil, false
	}
	return m.requestClientToolResult(ctx, key, gateCfg, def, input, cwd, types.GateOriginExtension), true
}
