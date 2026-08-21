package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func updateContextCapacityLocked(s *engineSession, model string, rawWindow, maxTokens int) conversation.ContextCapacity {
	capacity := conversation.ResolveModelContextCapacity(rawWindow, maxTokens, providers.GetModelInfo(model))
	s.lastContextLimit = capacity.EffectiveLimit
	s.lastContextWarning = s.lastContextTokens >= capacity.WarningLimit()
	return capacity
}

// rejectIfContextCapacityReached is the final prompt-admission gate. Only
// engine-owned backends send Ion's durable transcript to the provider, so only
// they can safely enforce this measurement. Native-session backends own their
// provider context and remain unblocked.
func (m *Manager) rejectIfContextCapacityReached(s *engineSession, key, requestID string, opts types.RunOptions, caps backend.BackendCapabilities, overrides *PromptOverrides) error {
	if caps.ContextModel != backend.ContextModelEngineOwned || s.conversationID == "" {
		return nil
	}

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "context capacity admission has no persisted conversation", map[string]any{"key": key, "conversation_id": s.conversationID, "error": utils.ErrStr(err)})
		return nil
	}
	capacity := conversation.ResolveModelContextCapacity(conversation.DefaultContext, opts.MaxTokens, providers.GetModelInfo(opts.Model))
	if info := providers.GetModelInfo(opts.Model); info != nil && info.ContextWindow > 0 {
		capacity = conversation.ResolveModelContextCapacity(info.ContextWindow, opts.MaxTokens, info)
	}
	usage := conversation.GetContextUsage(conv, capacity.EffectiveLimit)

	m.mu.Lock()
	if current, ok := m.sessions[key]; ok && current == s {
		current.lastContextTokens = usage.Tokens
		current.lastContextPct = usage.Percent
		current.lastContextWindow = capacity.RawLimit
		current.lastContextLimit = capacity.EffectiveLimit
		current.lastContextWarning = usage.Tokens >= capacity.WarningLimit()
	}
	if usage.Tokens < capacity.EffectiveLimit {
		m.mu.Unlock()
		return nil
	}
	s.clearRunIdentityFor(requestID)
	m.unbindRunLocked(requestID)
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelWarn, "session", "context capacity admission refused", map[string]any{
		"key": key, "run_id": requestID, "model": opts.Model, "context_tokens": usage.Tokens,
		"context_limit": capacity.EffectiveLimit, "context_window": capacity.RawLimit,
		"output_reserve": capacity.OutputReserve, "summary_reserve": capacity.SummaryReserve,
	})
	m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
	m.emit(key, types.EngineEvent{
		Type: "engine_error", ErrorCode: "context_limit_reached", ContextModel: opts.Model,
		ContextTokens: usage.Tokens, ContextLimit: capacity.EffectiveLimit, ContextWindow: capacity.RawLimit,
		ContextOutputReserve: capacity.OutputReserve, ContextSummaryReserve: capacity.SummaryReserve,
		EventMessage: fmt.Sprintf("context capacity reached for model %q; compact, clear, select a larger-context model, or start a new conversation", opts.Model),
	})
	return fmt.Errorf("context limit reached: occupancy=%d effective_limit=%d", usage.Tokens, capacity.EffectiveLimit)
}
