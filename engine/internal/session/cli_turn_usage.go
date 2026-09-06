package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Provider accounting for a delegated-CLI turn.
//
// An engine-owned run persists its own assistant messages with the usage the
// provider reported, so GetContextUsage's backward scan always finds a real
// baseline. A delegated-CLI run does not: Ion copies the turn into its
// transcript at run exit, and copied it with no accounting at all. The scan
// then fell through to character-count estimation over the whole conversation
// while still labelling the result exact — a conversation whose last measured
// baseline was 841,821 tokens reported 966,526 with estimated=false, the
// difference being a guess over the messages appended since.
//
// The CLI does report the numbers. They arrive on the same UsageEvent the live
// occupancy readout already consumes; this file retains the most recent one so
// run exit can persist it.

// captureCliTurnUsage retains the raw provider accounting from a run's usage
// events so persistCliTurn can stamp it on the assistant message it writes.
//
// Called for every normalized event; only UsageEvent does anything. The
// retained value is the LAST usage event of the run, which is the correct
// baseline: occupancy is what the model carried on its most recent request,
// not a sum across the turn's requests.
func (m *Manager) captureCliTurnUsage(key string, event types.NormalizedEvent) {
	ue, ok := event.Data.(*types.UsageEvent)
	if !ok {
		return
	}
	usage, ok := llmUsageFromOccupancy(ue.Usage)
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.cli_usage", "usage event carried no input accounting, nothing retained", map[string]any{"key": key})
		return
	}

	m.mu.Lock()
	s, exists := m.sessions[key]
	if !exists {
		m.mu.Unlock()
		return
	}
	// Only a delegated-CLI run persists its turn through persistCliTurn; an
	// engine-owned run writes its own usage in the runloop and must not have a
	// second baseline retained behind it. cliTranscript and pendingCliUserTurn
	// are both set at dispatch for exactly the native-session backends.
	if s.cliTranscript == nil && s.pendingCliUserTurn == "" {
		m.mu.Unlock()
		return
	}
	s.pendingCliUsage = &usage
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelDebug, "session.cli_usage", "retained delegated-cli turn usage", map[string]any{
		"key": key, "input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens,
		"cache_read_input_tokens": usage.CacheReadInputTokens, "cache_creation_input_tokens": usage.CacheCreationInputTokens,
	})
}

// llmUsageFromOccupancy converts a UsageEvent payload into the raw-component
// LlmUsage shape persistence expects. Reports false when the event carries no
// input accounting, so the caller leaves the turn unannotated rather than
// persisting a zero-valued record — which GetContextUsage would read as "the
// provider says ~0 tokens".
//
// UsageEvent.Usage.InputTokens is the SUMMED occupancy by contract (see
// occupancyUsage in internal/normalizer and the runloop's own emission), while
// a persisted LlmUsage carries the raw components and lets GetContextUsage sum
// them itself. Subtracting the components back out yields the provider's raw
// prompt count, so the persisted record reproduces the same total instead of
// counting the cache twice. Clamped at zero so a producer that ever emits an
// unsummed total cannot write a negative baseline.
func llmUsageFromOccupancy(u types.UsageData) (types.LlmUsage, bool) {
	total := derefUsageInt(u.InputTokens)
	cacheRead := derefUsageInt(u.CacheReadInputTokens)
	cacheCreate := derefUsageInt(u.CacheCreationInputTokens)
	if total == 0 && cacheRead == 0 && cacheCreate == 0 {
		return types.LlmUsage{}, false
	}
	raw := total - cacheRead - cacheCreate
	if raw < 0 {
		raw = 0
	}
	return types.LlmUsage{
		InputTokens:              raw,
		OutputTokens:             derefUsageInt(u.OutputTokens),
		CacheReadInputTokens:     cacheRead,
		CacheCreationInputTokens: cacheCreate,
	}, true
}

func derefUsageInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
