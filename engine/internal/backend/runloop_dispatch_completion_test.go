package backend

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestCompletedChildDispatch_EndTurnForcesContinuation(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("first turn", 10, 5),
		textResponse("completion consumed", 10, 5),
	})

	b := NewApiBackend()
	collector := collectEvents(b, "child-completion-end-turn")
	var mu sync.Mutex
	pending := true
	acked := 0
	cfg := &RunConfig{
		PeekCompletedChildDispatches: func() ([]types.LlmMessage, func()) {
			mu.Lock()
			defer mu.Unlock()
			if !pending {
				return nil, func() {}
			}
			return []types.LlmMessage{{Role: "user", Content: "[Agent reviewer completed]\nresult"}}, func() {
				mu.Lock()
				defer mu.Unlock()
				pending = false
				acked++
			}
		},
	}

	b.StartRunWithConfig("child-completion-end-turn", types.RunOptions{
		Prompt: "work", Model: testModel, EarlyStopEnabled: testEarlyStopDisabled(),
	}, cfg)
	if !waitForExit(collector, 5*time.Second) {
		t.Fatal("timed out waiting for completion continuation")
	}

	mu.Lock()
	gotAcked := acked
	mu.Unlock()
	if gotAcked != 1 {
		t.Fatalf("ack count = %d, want 1", gotAcked)
	}

	collector.mu.Lock()
	defer collector.mu.Unlock()
	steers := 0
	for _, event := range collector.normalized {
		if _, ok := event.Data.(*types.SteerInjectedEvent); ok {
			steers++
		}
	}
	if steers != 1 {
		t.Fatalf("completion injections = %d, want 1", steers)
	}
}
