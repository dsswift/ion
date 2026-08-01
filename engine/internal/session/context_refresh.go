package session

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// refreshContextUsage recomputes the session's retained context-usage state
// from the persisted conversation and writes it back onto the session.
//
// Why this exists. Every other writer of lastContextPct / lastContextTokens is
// event-driven: the session-start seed reads the conversation once, and the
// per-turn UsageEvent path updates while a run is streaming. Nothing refreshed
// the values at the moment a run ended, so an idle session reported whatever
// the last event happened to leave behind — including a stale figure from a
// prior model, or zero for backends that emit no usage events at all (the ACP
// backends emit none). Recomputing here makes the idle engine_status that
// handleRunExit emits carry a figure derived from what is actually on disk.
//
// Concurrency: the conversation load is disk I/O and happens outside the
// manager lock, matching the phase discipline in ComputeAndEmitContextBreakdown
// (snapshot under the lock, I/O outside, write back under the lock).
func (m *Manager) refreshContextUsage(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var convID, model string
	if ok {
		convID = s.conversationID
		model = s.lastModel
	}
	m.mu.RUnlock()

	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "refreshcontextusage: no such session", map[string]any{"key": key, "reason": reason})
		return
	}
	if convID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "refreshcontextusage: no conversation id, retaining prior values", map[string]any{"key": key, "reason": reason})
		return
	}

	// Resolve the denominator from the model the session last ran. An
	// unregistered or empty model falls back to the package default so the
	// percent is still computed against something meaningful; the absolute
	// token count is unaffected by this choice.
	ctxWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil && info.ContextWindow > 0 {
		ctxWindow = info.ContextWindow
	}

	utils.LogWithFields(utils.LevelDebug, "session", "refreshcontextusage: recomputing from persisted conversation", map[string]any{
		"key": key, "reason": reason, "conversation_id": convID, "model": model, "ctx_window": ctxWindow,
	})

	conv, err := conversation.Load(convID, "")
	if err != nil {
		// Non-fatal and expected for a session whose conversation file has
		// not been written yet (a run that produced nothing persistable).
		// Retain the prior values rather than zeroing a figure we cannot
		// currently verify.
		utils.LogWithFields(utils.LevelInfo, "session", "refreshcontextusage: conversation load failed, retaining prior values", map[string]any{
			"key": key, "reason": reason, "conversation_id": convID, "error": err,
		})
		return
	}

	usage := conversation.GetContextUsage(conv, ctxWindow)

	m.mu.Lock()
	if s2, ok2 := m.sessions[key]; ok2 {
		s2.lastContextTokens = usage.Tokens
		s2.lastContextPct = usage.Percent
		s2.lastContextWindow = ctxWindow
	}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session", "refreshcontextusage: refreshed", map[string]any{
		"key": key, "reason": reason, "conversation_id": convID, "model": model,
		"ctx_window": ctxWindow, "tokens": usage.Tokens, "pct": usage.Percent, "estimated": usage.Estimated,
	})
}
