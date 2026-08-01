package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// buildManualCompactState builds only the target session state CompactNow
// consumes. It deliberately does not use ApiBackend.lastRunConfig: that cache
// belongs to whichever session ran most recently on the shared backend.
func (m *Manager) buildManualCompactState(s *engineSession, key, runID, model string) (*backend.RunConfig, types.RunOptions) {
	opts := buildRunOptions(s, "", nil)
	opts.Model = model
	m.applyConfigDefaults(&opts)

	cfg := &backend.RunConfig{}
	if s.telemetry != nil {
		cfg.Telemetry = &telemetryAdapter{c: s.telemetry}
	}
	if s.sessionMemory != nil {
		sm := s.sessionMemory
		cfg.GetSessionMemory = sm.GetMemory
		cfg.GetLastSummarizedEntryID = sm.GetLastSummarizedEntryID
		cfg.ResetMemoryTracking = func(tokens int) {
			sm.ResetUpdateTracking(tokens, sm.GetLastUpdateTurn())
		}
	}
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		group := s.extGroup
		cfg.Hooks.OnSessionBeforeCompact = func(_ string) bool {
			cancel, _ := group.FireSessionBeforeCompact(ctx, extension.CompactionInfo{}) //nolint:errcheck // errors logged internally
			return cancel
		}
		cfg.Hooks.OnRequestCompactSummary = func(_ string, strategy string, messages []types.LlmMessage) (string, bool) {
			summary, ok := group.FireCompactSummaryRequest(ctx, extension.CompactSummaryRequestInfo{
				Strategy: strategy, MessageCount: len(messages), Messages: messages,
			})
			utils.LogWithFields(utils.LevelDebug, "session", "manual compact summary request", map[string]any{
				"run_id": runID, "strategy": strategy, "message_count": len(messages), "ok": ok,
			})
			return summary, ok
		}
		cfg.Hooks.OnSessionCompact = func(_ string, info interface{}) {
			ci, ok := info.(map[string]interface{})
			if !ok {
				utils.LogWithFields(utils.LevelWarn, "session", "manual compact hook payload wrong type", map[string]any{"run_id": runID})
				return
			}
			payload := extension.CompactionInfo{
				Strategy: fmtString(ci["strategy"]), MessagesBefore: toInt(ci["messagesBefore"]),
				MessagesAfter: toInt(ci["messagesAfter"]), TokensBefore: toInt(ci["tokensBefore"]),
				TokenLimit: toInt(ci["tokenLimit"]), TargetTokens: toInt(ci["targetTokens"]),
				MicroCompactKeep: toInt(ci["microCompactKeep"]), TokensAfter: toInt(ci["tokensAfter"]),
			}
			if facts, ok := ci["facts"].([]compaction.Fact); ok {
				payload.Facts = make([]extension.CompactionFact, len(facts))
				for i := range facts {
					payload.Facts[i] = extension.CompactionFact{Type: facts[i].Type, Content: facts[i].Content}
				}
			}
			group.FireSessionCompact(ctx, payload)
		}
	}
	return cfg, opts
}

func fmtString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
