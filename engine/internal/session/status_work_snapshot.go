package session

import "github.com/dsswift/ion/engine/internal/types"

// buildStatusFields reads the exact session-owned work inventory under one
// manager lock. It exposes no client estimate: idle plus HasPendingWork means
// accepted work remains and must not be treated as terminal.
func (m *Manager) buildStatusFields(key string) (*types.StatusFields, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		return nil, false
	}
	agents := 0
	if s.dispatchRegistry != nil {
		agents = len(s.dispatchRegistry.ActiveIDs())
	}
	fields := &types.StatusFields{
		Label:                 key,
		State:                 m.currentSessionStatus(s),
		BackgroundAgents:      agents,
		BackgroundShells:      len(s.outstandingBackgroundTasks),
		HasPendingWork:        agents > 0 || len(s.outstandingBackgroundTasks) > 0 || len(s.promptQueue) > 0 || len(s.rootDispatchCompletions) > 0 || len(s.pendingBackgroundCompletions) > 0 || s.parked != nil,
		SessionID:             s.conversationID,
		ContextPercent:        s.lastContextPct,
		ContextWindow:         s.lastContextWindow,
		ContextTokens:         s.lastContextTokens,
		ContextEffectiveLimit: s.lastContextLimit,
		Model:                 s.lastModel,
		RunCostUsd:            s.lastTotalCost,
		CompletionReason:      s.lastCompletionReason,
		ConversationCostUsd:   s.lastConvCost,
		PermissionDenials:     s.lastPermissionDenials,
	}
	return fields, true
}
