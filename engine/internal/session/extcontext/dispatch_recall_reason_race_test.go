package extcontext

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// lateRecallAccessor holds a finished dispatch at its terminal snapshot, so a
// test can recall the dispatch after its child exited and before it
// deregisters.
type lateRecallAccessor struct {
	*depthTestAccessor
	atTerminal chan struct{}
	hold       time.Duration
}

func (a *lateRecallAccessor) EmitAgentSnapshot(reason string) {
	if reason != "dispatch_end" {
		return
	}
	select {
	case a.atTerminal <- struct{}{}:
	default:
	}
	// A timed hold, not a channel: a release the test signalled after its
	// recall would order the recall's write before the dispatch's read and
	// hide an unsynchronized access from the race detector.
	time.Sleep(a.hold)
}

// TestDispatchRecall_AfterChildExitIsRaceFree recalls a background dispatch
// whose child already exited on its own. The recall records its reason on the
// caller's goroutine while the dispatch goroutine is still finishing and reads
// that reason to build its registry outcome. Run under -race.
func TestDispatchRecall_AfterChildExitIsRaceFree(t *testing.T) {
	acc := &lateRecallAccessor{
		depthTestAccessor: &depthTestAccessor{childStart: make(chan struct{}, 1)},
		atTerminal:        make(chan struct{}, 1),
		hold:              100 * time.Millisecond,
	}
	registry := NewDispatchRegistry()
	dispatchFn := BuildDispatchAgentFunc(acc, registry, 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "late-recall-agent",
		Task:       "exit before the recall",
		Background: true,
	})
	if err != nil || result == nil || result.DispatchID == "" {
		t.Fatalf("background dispatch did not start: result=%+v err=%v", result, err)
	}

	select {
	case <-acc.atTerminal:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatch never reached its terminal snapshot")
	}

	registry.RecallByID(result.DispatchID, "late recall")

	deadline := time.Now().Add(5 * time.Second)
	for registry.Count() > 0 {
		if time.Now().After(deadline) {
			t.Fatal("dispatch never deregistered")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
