package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestPersistCliTurn_WritesRunBillingToHeader pins the fix for delegated-CLI
// conversations reporting a $0 header forever. The CLI reports its own cost and
// a per-run token sum on task_complete; before this, both lived only in the
// run-scoped lastTotalCost and died with the run, so every consumer that reads
// the conversation header (cost breakdown, conversation list, export, the
// aggregate_cost in run.complete telemetry) reported zero.
//
// Reverting either write in persistCliTurn turns this red.
func TestPersistCliTurn_WritesRunBillingToHeader(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("cli-billing", defaultConfig())

	const convID = "1784000000000-b111111111b1"
	mgr.mu.Lock()
	s := mgr.sessions["cli-billing"]
	s.conversationID = convID
	s.pendingCliUserTurn = "plan the refactor"
	s.pendingCliAssistantText = "Here is the plan."
	s.pendingCliRunCostUsd = 2.6054470
	// The real shape observed from a 3-turn Claude Code run: the CLI sums each
	// turn's tokens into one figure on the result event.
	s.pendingCliRunUsage = types.LlmUsage{
		InputTokens:              114,
		OutputTokens:             12176,
		CacheReadInputTokens:     443672,
		CacheCreationInputTokens: 93413,
	}
	mgr.mu.Unlock()

	mgr.persistCliTurn("cli-billing", convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if conv.TotalCost != 2.6054470 {
		t.Errorf("TotalCost = %v, want 2.605447", conv.TotalCost)
	}
	// Header input total counts cached tokens: they occupy the window and are
	// billed, so 114 + 443672 + 93413.
	if want := 114 + 443672 + 93413; conv.TotalInputTokens != want {
		t.Errorf("TotalInputTokens = %d, want %d", conv.TotalInputTokens, want)
	}
	if conv.TotalOutputTokens != 12176 {
		t.Errorf("TotalOutputTokens = %d, want 12176", conv.TotalOutputTokens)
	}

	// Pending billing cleared, so a later run exit cannot double-count.
	mgr.mu.RLock()
	cost, usage := s.pendingCliRunCostUsd, s.pendingCliRunUsage
	mgr.mu.RUnlock()
	if cost != 0 || usage != (types.LlmUsage{}) {
		t.Errorf("pending billing not cleared: cost=%v usage=%+v", cost, usage)
	}
}

// TestPersistCliTurn_RunBillingDoesNotReachOccupancy is the other half of the
// contract. The CLI's figure is a sum over the run's turns, not the size of the
// context at the end of it. GetContextUsage scans backward for the last message
// carrying Usage and reads it as the live context, so the run sum must reach the
// header and no message. Annotating the assistant message instead would report
// an occupancy several times the real one and drive premature compaction.
func TestPersistCliTurn_RunBillingDoesNotReachOccupancy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	_, _ = mgr.StartSession("cli-occupancy", defaultConfig())

	const convID = "1784000000000-b222222222b2"
	mgr.mu.Lock()
	s := mgr.sessions["cli-occupancy"]
	s.conversationID = convID
	s.pendingCliUserTurn = "short prompt"
	s.pendingCliAssistantText = "short answer"
	s.pendingCliRunCostUsd = 2.60
	s.pendingCliRunUsage = types.LlmUsage{InputTokens: 114, OutputTokens: 12176, CacheReadInputTokens: 443672, CacheCreationInputTokens: 93413}
	mgr.mu.Unlock()

	mgr.persistCliTurn("cli-occupancy", convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	for i, m := range conv.Messages {
		if m.Usage != nil {
			t.Fatalf("message %d (role %s) carries Usage %+v; the run sum must stay on the header", i, m.Role, *m.Usage)
		}
	}
	// With no message-level Usage the scan finds nothing and falls back to the
	// heuristic estimate of the actual content — a two-line turn, nowhere near
	// the half-million-token run sum.
	got := conversation.GetContextUsage(conv, 1000000)
	if !got.Estimated {
		t.Errorf("occupancy reported as API-derived; want heuristic estimate")
	}
	if got.Tokens > 10000 {
		t.Errorf("occupancy = %d tokens for a two-line turn; the run sum leaked into the scan", got.Tokens)
	}
}

// TestTaskComplete_ConversationCostIncludesCliRun pins the cached
// ConversationCostUsd to the same rule aggregate_cost_usd follows. Both read
// cost.ConversationCost, which walks the conversation header on disk. An
// engine-owned run has already saved its per-turn cost by the time
// task_complete arrives; a delegated-CLI run has not — persistCliTurn writes it
// at run exit, after this event. Without the explicit add, every status
// snapshot, heartbeat, and host_death notice between this run's completion and
// the next one reports a conversation cost missing the run the user just paid
// for, and only for the CLI backend.
//
// Reverting the `if s2.pendingCliUserTurn != ""` add in handleNormalizedEvent
// turns this red.
func TestTaskComplete_ConversationCostIncludesCliRun(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	if _, err := mgr.StartSession("cli-convcost", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions["cli-convcost"]
	s.conversationID = "1784000000000-b333333333b3"
	// Set by prompt dispatch for every native-session (delegated-CLI) run; it
	// is what distinguishes a run whose cost is still unwritten.
	s.pendingCliUserTurn = "plan the refactor"
	mgr.bindRunLocked("run-convcost", "cli-convcost")
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-convcost", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{CostUsd: 2.6054470},
	})

	mgr.mu.RLock()
	got := s.lastConvCost
	mgr.mu.RUnlock()
	// Nothing on disk yet, so the walk contributes 0 and the run's own cost is
	// the whole figure.
	if got != 2.6054470 {
		t.Errorf("lastConvCost = %v, want 2.605447 (the CLI run's reported cost)", got)
	}
}

// TestTaskComplete_ConversationCostExcludesEngineOwnedRun is the control arm.
// An engine-owned run saved its cost per turn inside the runloop, so the disk
// walk already counts it; adding the event's figure on top would double-count
// the run in every status snapshot. pendingCliUserTurn empty is what marks it.
func TestTaskComplete_ConversationCostExcludesEngineOwnedRun(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	if _, err := mgr.StartSession("api-convcost", defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions["api-convcost"]
	s.conversationID = "1784000000000-b444444444b4"
	mgr.bindRunLocked("run-api-convcost", "api-convcost")
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-api-convcost", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{CostUsd: 2.6054470},
	})

	mgr.mu.RLock()
	got := s.lastConvCost
	mgr.mu.RUnlock()
	if got != 0 {
		t.Errorf("lastConvCost = %v, want 0; an engine-owned run is already counted by the disk walk", got)
	}
}
