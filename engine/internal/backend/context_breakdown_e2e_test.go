package backend

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestContextBreakdownEmittedEndToEnd is the in-repo consumer validation for
// the engine_context_breakdown wire event. It runs a full agent loop through a
// mock provider and asserts that the normalized context_breakdown event is
// emitted end-to-end (it is translated to engine_context_breakdown by the
// session layer; here we assert at the normalized-event seam the runloop emits).
//
// This replaces the ion-meta extension consumer originally scoped for this
// work: the extension SDK's `ion.on` accepts only hook names, not arbitrary
// outbound engine wire events, so an extension cannot subscribe to
// engine_context_breakdown. The engine's own event stream is the authoritative
// in-repo consumer surface, and this test is what CI validates so the event is
// proven emittable end-to-end. See the run report for the SDK-limitation
// blocker note.
func TestContextBreakdownEmittedEndToEnd(t *testing.T) {
	// Model with a known tiktoken encoder so the breakdown resolves at the
	// local tier without any network call (mockLlmProvider.CountTokens returns
	// ErrCountUnsupported).
	setupTestProviderModel("gpt-4o", [][]types.LlmStreamEvent{
		textResponse("hello", 1234, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-breakdown")
	b.StartRun("req-breakdown", types.RunOptions{
		Prompt:           "count my context",
		ProjectPath:      "/tmp",
		Model:            "gpt-4o",
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	var initial, reconciled *types.ContextBreakdownEvent
	for _, ev := range c.normalized {
		bd, ok := ev.Data.(*types.ContextBreakdownEvent)
		if !ok {
			continue
		}
		if bd.APIReportedTotal == 0 && !hasUnaccounted(bd) {
			initial = bd
		} else {
			reconciled = bd
		}
	}

	if initial == nil {
		t.Fatal("expected an initial context_breakdown event (pre-reconcile), got none")
	}
	if initial.Model != "gpt-4o" {
		t.Errorf("initial breakdown model = %q, want gpt-4o", initial.Model)
	}
	if len(initial.Categories) == 0 {
		t.Error("initial breakdown has no categories")
	}
	if initial.ContextWindow == 0 {
		t.Error("initial breakdown missing context window")
	}

	if reconciled == nil {
		t.Fatal("expected a reconciled context_breakdown event (post-usage), got none")
	}
	if reconciled.APIReportedTotal == 0 {
		t.Error("reconciled breakdown missing APIReportedTotal")
	}
	if !hasUnaccounted(reconciled) {
		t.Error("reconciled breakdown missing an unaccounted row (drift must be surfaced)")
	}
}

func hasUnaccounted(bd *types.ContextBreakdownEvent) bool {
	for _, cat := range bd.Categories {
		if cat.Kind == "unaccounted" {
			return true
		}
	}
	return false
}
