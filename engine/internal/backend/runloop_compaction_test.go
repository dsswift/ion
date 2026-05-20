package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// captureEvents wires the backend's normalized-event callback into a slice
// so tests can inspect what compactIfNeeded emitted.
func captureEvents(b *ApiBackend, requestID string) *[]types.NormalizedEvent {
	var captured []types.NormalizedEvent
	b.OnNormalized(func(id string, ev types.NormalizedEvent) {
		if id == requestID {
			captured = append(captured, ev)
		}
	})
	return &captured
}

func TestCompactIfNeeded_CircuitBreaker(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "circuit-test")

	conv := conversation.CreateConversation("circuit-test", "", "test-model")
	// Provide enough messages for Compact to drop something but not collapse
	// to empty. The actual content does not matter for this test.
	for i := 0; i < 12; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	run := &activeRun{requestID: "circuit-test", conv: conv}

	// Each iteration simulates a runloop pass where the reported token count
	// is stuck above the limit (e.g. the model keeps returning a huge prompt
	// usage figure). Re-priming LastInputTokens between calls mimics what
	// would happen if a successful response set it high and compaction
	// failed to shrink the working set.
	for i := 0; i < maxConsecutiveCompactions; i++ {
		conv.LastInputTokens = 180_000
		conv.LastInputTokensMsgCount = len(conv.Messages)
		b.compactIfNeeded(run, conv, RunHooks{}, 200_000, 100_000)
	}

	if run.compactionsWithoutProgress != maxConsecutiveCompactions {
		t.Fatalf("compactionsWithoutProgress = %d, want %d",
			run.compactionsWithoutProgress, maxConsecutiveCompactions)
	}

	// Fourth attempt: should hit the circuit breaker and emit
	// compact_loop_aborted instead of running another compaction.
	conv.LastInputTokens = 180_000
	conv.LastInputTokensMsgCount = len(conv.Messages)
	beforeCounter := run.compactionsWithoutProgress
	b.compactIfNeeded(run, conv, RunHooks{}, 200_000, 100_000)

	if run.compactionsWithoutProgress != beforeCounter {
		t.Errorf("counter advanced past circuit breaker: %d -> %d",
			beforeCounter, run.compactionsWithoutProgress)
	}

	// Confirm a compact_loop_aborted ErrorEvent was emitted.
	var sawAborted bool
	for _, ev := range *events {
		if errEv, ok := ev.Data.(*types.ErrorEvent); ok && errEv.ErrorCode == "compact_loop_aborted" {
			sawAborted = true
			break
		}
	}
	if !sawAborted {
		t.Errorf("expected ErrorEvent with code compact_loop_aborted; saw %d events", len(*events))
	}
}

func TestCompactIfNeeded_BelowLimitIsNoOp(t *testing.T) {
	b := NewApiBackend()
	events := captureEvents(b, "below-limit")

	conv := conversation.CreateConversation("below-limit", "", "test-model")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.LastInputTokens = 1000
	conv.LastInputTokensMsgCount = 1

	run := &activeRun{requestID: "below-limit", conv: conv}

	b.compactIfNeeded(run, conv, RunHooks{}, 200_000, 100_000)

	if run.compactionsWithoutProgress != 0 {
		t.Errorf("counter advanced on no-op call: %d", run.compactionsWithoutProgress)
	}
	if len(*events) != 0 {
		t.Errorf("expected no events on below-limit call, got %d", len(*events))
	}
}
