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
		PeekCompletedChildDispatches: func() ([]types.BackgroundWorkDelivery, func()) {
			mu.Lock()
			defer mu.Unlock()
			if !pending {
				return nil, func() {}
			}
			return []types.BackgroundWorkDelivery{{
					Content: "[Agent reviewer completed]\nresult",
					Work:    types.BackgroundWorkInfo{Kind: string(types.InjectionKindAgentCompletion), DeliveryMode: "steer", Items: []types.BackgroundWorkItem{{ID: "dispatch-reviewer", Source: types.BackgroundWorkSourceAgent, Label: "reviewer", Status: "completed", ExitCode: 0}}},
				}}, func() {
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
	deliveries := 0
	for _, event := range collector.normalized {
		if _, ok := event.Data.(*types.BackgroundWorkDeliveredEvent); ok {
			deliveries++
		}
	}
	if deliveries != 1 {
		t.Fatalf("completion deliveries = %d, want 1", deliveries)
	}

}
