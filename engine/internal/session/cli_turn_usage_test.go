package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func intp(v int) *int { return &v }

// A delegated-CLI turn used to be persisted with no provider accounting at
// all, so GetContextUsage's backward scan found no baseline and estimated the
// whole conversation from character counts — while still reporting the result
// as exact. These arms pin that a run which reports usage lands a real
// baseline, and that a run which reports none still writes nothing rather than
// a zero-valued record.

// TestCaptureCliTurnUsage_PersistsProviderBaseline is the regression arm:
// after a CLI run that reported usage, the conversation's context usage is
// provider-measured, not estimated.
func TestCaptureCliTurnUsage_PersistsProviderBaseline(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "cli-usage", "1784000000010-aaaaaaaaaaaa"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.pendingCliUserTurn = "summarise the repository"
	s.pendingCliAssistantText = "Here is the summary."
	mgr.mu.Unlock()

	// The shape Claude Code reports on message_start, already summed into
	// InputTokens by the normalizer: 2 raw prompt tokens against an 840,543
	// token cache read.
	total := 2 + 840543 + 344
	mgr.captureCliTurnUsage(key, types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{
		InputTokens:              intp(total),
		OutputTokens:             intp(135),
		CacheReadInputTokens:     intp(840543),
		CacheCreationInputTokens: intp(344),
	}}})

	mgr.persistCliTurn(key, convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	usage := conversation.LastAssistantUsage(conv)
	if usage == nil {
		t.Fatal("no provider usage on the persisted CLI turn — the occupancy scan has no baseline")
	}
	if got := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens; got != total {
		t.Errorf("persisted occupancy = %d, want %d", got, total)
	}

	info := conversation.GetContextUsage(conv, 1000000)
	if info.Estimated {
		t.Error("context usage still reports Estimated=true after a CLI turn that carried provider accounting")
	}
	if info.Tokens != total {
		t.Errorf("context tokens = %d, want %d", info.Tokens, total)
	}
}

// TestCaptureCliTurnUsage_NoAccountingLeavesTurnUnannotated pins the guard
// that predates this change: a run reporting nothing must not write a
// zero-valued LlmUsage, which the backward scan would read as "the provider
// says ~0 tokens" and treat as a real baseline.
func TestCaptureCliTurnUsage_NoAccountingLeavesTurnUnannotated(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "cli-usage-none", "1784000000011-bbbbbbbbbbbb"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.pendingCliUserTurn = "hello"
	s.pendingCliAssistantText = "hi"
	mgr.mu.Unlock()

	mgr.captureCliTurnUsage(key, types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{}}})
	mgr.persistCliTurn(key, convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if u := conversation.LastAssistantUsage(conv); u != nil {
		t.Errorf("expected no usage annotation, got %+v", u)
	}
}

// TestLlmUsageFromOccupancy_RoundTripsTheSummedTotal pins the conversion
// between the two accounting conventions: UsageEvent carries a pre-summed
// InputTokens, a persisted LlmUsage carries raw components that
// GetContextUsage sums itself. The persisted record must reproduce the event's
// total exactly — never double-count the cache.
func TestLlmUsageFromOccupancy_RoundTripsTheSummedTotal(t *testing.T) {
	total := 2 + 840543 + 344
	got, ok := llmUsageFromOccupancy(types.UsageData{
		InputTokens:              intp(total),
		CacheReadInputTokens:     intp(840543),
		CacheCreationInputTokens: intp(344),
		OutputTokens:             intp(7),
	})
	if !ok {
		t.Fatal("expected accounting to be recognised")
	}
	if got.InputTokens != 2 {
		t.Errorf("raw InputTokens = %d, want 2", got.InputTokens)
	}
	if sum := got.InputTokens + got.CacheReadInputTokens + got.CacheCreationInputTokens; sum != total {
		t.Errorf("round-tripped total = %d, want %d", sum, total)
	}
	if _, ok := llmUsageFromOccupancy(types.UsageData{OutputTokens: intp(9)}); ok {
		t.Error("output-only usage must not be treated as an occupancy baseline")
	}
}
