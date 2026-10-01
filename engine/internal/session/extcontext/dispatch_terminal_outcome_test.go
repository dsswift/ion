package extcontext

import (
	"fmt"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests that every terminal dispatch outcome carries the child conversation ID
// (issue #380), that the value is the one the live dispatch entry exposed, and
// that it is absent when the child never initialized a conversation.

const terminalOutcomeWait = 5 * time.Second

// awaitLiveChildConvID polls the registry until the named dispatch's live
// entry exposes a child conversation ID, and returns it.
func awaitLiveChildConvID(t *testing.T, registry *DispatchRegistry, name string) string {
	t.Helper()
	deadline := time.Now().Add(terminalOutcomeWait)
	for time.Now().Before(deadline) {
		for _, entry := range registry.Snapshot() {
			if entry.Name == name && entry.ChildConversationID != "" {
				return entry.ChildConversationID
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("live dispatch entry for %q never exposed a child conversation ID", name)
	return ""
}

func awaitOutcome[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(terminalOutcomeWait):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// TestTerminalOutcome_CompleteCarriesLiveChildConversationID pins the
// completion path: OnComplete carries the same ID the live entry exposed.
//
// Revert-red: drop ChildConversationID from the terminal result in
// dispatch_agent.go and the result reads "".
func TestTerminalOutcome_CompleteCarriesLiveChildConversationID(t *testing.T) {
	child := &blockingChildBackend{convID: "conv-outcome-complete", gate: make(chan struct{})}
	registry := NewDispatchRegistry()
	completed := make(chan extension.DispatchAgentResult, 1)

	dispatchFn := BuildDispatchAgentFunc(&idTestAccessor{child: child}, registry, 0, "")
	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "outcome-complete",
		Task:       "finish",
		Background: true,
		OnComplete: func(r extension.DispatchAgentResult) { completed <- r },
	})
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if stub.ChildConversationID != "" {
		t.Errorf("asynchronous stub ChildConversationID = %q, want empty: the child has not started", stub.ChildConversationID)
	}

	live := awaitLiveChildConvID(t, registry, "outcome-complete")
	close(child.gate)

	result := awaitOutcome(t, completed, "OnComplete")
	if result.ChildConversationID != live {
		t.Errorf("OnComplete ChildConversationID = %q, want the live entry's %q", result.ChildConversationID, live)
	}
}

// TestTerminalOutcome_ForegroundResultCarriesChildConversationID pins the
// synchronous path, which returns the terminal result directly.
func TestTerminalOutcome_ForegroundResultCarriesChildConversationID(t *testing.T) {
	child := &idChildBackend{convID: "conv-outcome-fg"}
	dispatchFn := BuildDispatchAgentFunc(&idTestAccessor{child: child}, NewDispatchRegistry(), 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "outcome-fg",
		Task:              "finish",
	})
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if result.ChildConversationID != "conv-outcome-fg" {
		t.Errorf("foreground ChildConversationID = %q, want conv-outcome-fg", result.ChildConversationID)
	}
}

// TestTerminalOutcome_ErrorCarriesChildConversationID pins the failure path.
//
// Revert-red: build the DispatchError without ChildConversationID and this
// reads "".
func TestTerminalOutcome_ErrorCarriesChildConversationID(t *testing.T) {
	child := &errorChildBackend{convID: "conv-outcome-err"}
	failed := make(chan extension.DispatchError, 1)

	dispatchFn := BuildDispatchAgentFunc(&idTestAccessor{child: child}, NewDispatchRegistry(), 0, "")
	if _, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "outcome-err",
		Task:       "fail",
		Background: true,
		OnError:    func(e extension.DispatchError) { failed <- e },
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	got := awaitOutcome(t, failed, "OnError")
	if got.ChildConversationID != "conv-outcome-err" {
		t.Errorf("OnError ChildConversationID = %q, want conv-outcome-err", got.ChildConversationID)
	}
}

// noInitErrorChildBackend fails without ever emitting SessionInitEvent: the
// dispatch ends before any child conversation exists.
type noInitErrorChildBackend struct {
	errorChildBackend
}

func (d *noInitErrorChildBackend) StartRun(requestID string, _ types.RunOptions) {
	d.mu.Lock()
	onExit, onErr := d.onExit, d.onErr
	d.mu.Unlock()
	go func() {
		if onErr != nil {
			onErr(requestID, fmt.Errorf("failed before init"))
		}
		if onExit != nil {
			one := 1
			onExit(requestID, &one, nil, "")
		}
	}()
}

// TestTerminalOutcome_ErrorBeforeConversationOmitsID pins the omission rule:
// a dispatch that failed before its child conversation existed reports no ID.
func TestTerminalOutcome_ErrorBeforeConversationOmitsID(t *testing.T) {
	child := &noInitErrorChildBackend{}
	failed := make(chan extension.DispatchError, 1)

	dispatchFn := BuildDispatchAgentFunc(&idTestAccessor{child: child}, NewDispatchRegistry(), 0, "")
	if _, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "outcome-noinit",
		Task:       "fail early",
		Background: true,
		OnError:    func(e extension.DispatchError) { failed <- e },
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	got := awaitOutcome(t, failed, "OnError")
	if got.ExitCode == 0 {
		t.Fatalf("expected a failed outcome, got %#v", got)
	}
	if got.ChildConversationID != "" {
		t.Errorf("ChildConversationID = %q, want empty: no child conversation was created", got.ChildConversationID)
	}
}

// TestTerminalOutcome_RecallCarriesLiveChildConversationID pins both recall
// triggers: a targeted recall (what a caller's timeout or explicit recall
// issues) and RecallAll (session abort and shutdown). Each also pins that the
// recaller's reason reaches RecallInfo.Reason, with recall_agent standing in
// only when no reason was given.
//
// Revert-red: build the RecallInfo without ChildConversationID and every
// subtest reads ""; register the dispatch with a plain cancel that ignores the
// reason and the reason assertions read recall_agent.
func TestTerminalOutcome_RecallCarriesLiveChildConversationID(t *testing.T) {
	cases := []struct {
		name       string
		recall     func(r *DispatchRegistry, id string)
		wantReason string
	}{
		{"targeted recall", func(r *DispatchRegistry, id string) { r.RecallByID(id, "timeout") }, "timeout"},
		{"targeted recall without reason", func(r *DispatchRegistry, id string) { r.RecallByID(id, "") }, "recall_agent"},
		{"shutdown recall", func(r *DispatchRegistry, _ string) { r.RecallAll("engine shutdown") }, "engine shutdown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			child := &blockingChildBackend{convID: "conv-outcome-recall", gate: make(chan struct{})}
			registry := NewDispatchRegistry()
			recalled := make(chan extension.RecallInfo, 1)

			dispatchFn := BuildDispatchAgentFunc(&idTestAccessor{child: child}, registry, 0, "")
			stub, err := dispatchFn(extension.DispatchAgentOpts{
				Name:       "outcome-recall",
				Task:       "run until recalled",
				Background: true,
				OnRecall:   func(info extension.RecallInfo) { recalled <- info },
			})
			if err != nil {
				t.Fatalf("dispatch: %v", err)
			}

			live := awaitLiveChildConvID(t, registry, "outcome-recall")
			tc.recall(registry, stub.DispatchID)
			// The mock backend ignores Cancel; releasing the gate stands in
			// for a real backend draining after the cancel.
			close(child.gate)

			got := awaitOutcome(t, recalled, "OnRecall")
			if got.ChildConversationID != live {
				t.Errorf("OnRecall ChildConversationID = %q, want the live entry's %q", got.ChildConversationID, live)
			}
			if got.Reason != tc.wantReason {
				t.Errorf("OnRecall Reason = %q, want %q", got.Reason, tc.wantReason)
			}
		})
	}
}

// TestTerminalOutcome_PanicCarriesRecordedChildConversationID pins the
// recovered-panic path, which reads the ID from the registry entry before it
// deregisters the dispatch.
//
// Revert-red: drop the ChildConvIDForID lookup in
// recoverBackgroundDispatchPanic and the result reads "".
func TestTerminalOutcome_PanicCarriesRecordedChildConversationID(t *testing.T) {
	for _, tc := range []struct {
		name   string
		convID string
	}{
		{"conversation recorded", "conv-outcome-panic"},
		{"no conversation yet", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registry := NewDispatchRegistry()
			registry.RegisterWithID("panicking", "worker", func(string) {}, nil, "panic-outcome-session", "", 1)
			if tc.convID != "" {
				registry.SetChildConvID("panicking", tc.convID)
			}

			results := make(chan extension.DispatchAgentResult, 1)
			recoverBackgroundDispatchPanic(
				&panicTestAccessor{}, registry,
				extension.DispatchAgentOpts{Name: "worker", Task: "panic"},
				"panic-outcome-session", "panicking", "worker", "boom", 1, "", nil,
				func(result extension.DispatchAgentResult) { results <- result },
			)

			result := awaitOutcome(t, results, "panic terminal callback")
			if result.ChildConversationID != tc.convID {
				t.Errorf("panic result ChildConversationID = %q, want %q", result.ChildConversationID, tc.convID)
			}
			if got := terminalDispatchError(result).ChildConversationID; got != tc.convID {
				t.Errorf("panic DispatchError ChildConversationID = %q, want %q", got, tc.convID)
			}
		})
	}
}
