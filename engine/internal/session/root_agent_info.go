package session

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
)

// rootBeforeAgentStartInfo builds the before_agent_start payload for the root
// loop. Root has depth zero, so its remaining budget is the resolved engine
// dispatch cap. The task is empty for primary prompt injection and non-empty
// when the generic Agent tool asks extensions to select a sub-agent.
func (m *Manager) rootBeforeAgentStartInfo(task string) extension.AgentInfo {
	engineCap := 0
	m.mu.RLock()
	if m.config != nil {
		engineCap = m.config.MaxDispatchDepth
	}
	m.mu.RUnlock()
	return extension.AgentInfo{
		Task:                 task,
		IsRoot:               true,
		RemainingDepthBudget: extcontext.RemainingDepthBudgetForRoot(engineCap),
	}
}
