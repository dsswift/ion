package extcontext

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// Tests for the per-completion durability write. A dispatch's terminal
// agent_dispatch record used to be written ONLY by the parent's run-exit sweep
// (Manager.persistTerminalDispatches from handleRunExit). A dispatch that
// completes while the parent is parked therefore stayed on disk as `running`
// until the parent happened to exit another run — and if the engine died first,
// the next start's rehydration read the stale `running` record, correctly (given
// the file) declared the dispatch lost, and flipped a cleanly-completed 25-turn
// dispatch to `error`. The completion path now writes its own terminal record
// through SessionAccessor.PersistDispatchTerminal.

// terminalPersistAccessor records every PersistDispatchTerminal call so a test
// can assert the completion path performs the durability write itself, with the
// dispatch's own id. Everything else delegates to idTestAccessor.
type terminalPersistAccessor struct {
	*idTestAccessor

	pmu       sync.Mutex
	persisted []string
}

func (a *terminalPersistAccessor) PersistDispatchTerminal(agentID string) {
	a.pmu.Lock()
	defer a.pmu.Unlock()
	a.persisted = append(a.persisted, agentID)
}

func (a *terminalPersistAccessor) persistedIDs() []string {
	a.pmu.Lock()
	defer a.pmu.Unlock()
	out := make([]string, len(a.persisted))
	copy(out, a.persisted)
	return out
}

// waitForPersist polls until at least one terminal persist is recorded, so the
// async completion path is not raced by a fixed sleep.
func waitForPersist(t *testing.T, acc *terminalPersistAccessor) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if ids := acc.persistedIDs(); len(ids) > 0 {
			return ids
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for PersistDispatchTerminal; the completion path performed no durability write")
	return nil
}

// TestDispatchTerminal_CompletionPersistsOwnRecord pins the exit-0 path: the
// dispatch persists its terminal record at its own completion transition.
//
// Revert-red: remove the sa.PersistDispatchTerminal(agentID) call in
// dispatch_agent.go's terminal handler and this test fails — which is exactly
// the state in which a completed dispatch reads back as `running` and is
// reported lost after a restart.
func TestDispatchTerminal_CompletionPersistsOwnRecord(t *testing.T) {
	child := &idChildBackend{convID: "conv-term-1"}
	acc := &terminalPersistAccessor{idTestAccessor: &idTestAccessor{child: child}}

	dispatchFn := BuildDispatchAgentFunc(acc, NewDispatchRegistry(), 0, "")

	result, err := dispatchFn(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "term-agent",
		Task:              "do something durable",
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}

	ids := waitForPersist(t, acc)
	if len(ids) != 1 {
		t.Fatalf("PersistDispatchTerminal calls = %v, want exactly one", ids)
	}
	if ids[0] != result.DispatchID {
		t.Errorf("persisted id = %q, want the dispatch's own id %q", ids[0], result.DispatchID)
	}
}

// TestDispatchTerminal_ErrorPersistsOwnRecord pins the same write on the
// failure path: an errored dispatch is as much a terminal outcome as a
// completed one, and must not read back as `running` either.
//
// Revert-red: same call removal as above.
func TestDispatchTerminal_ErrorPersistsOwnRecord(t *testing.T) {
	child := &errorChildBackend{convID: "conv-term-err-1"}
	acc := &terminalPersistAccessor{idTestAccessor: &idTestAccessor{child: child}}

	done := make(chan struct{})
	dispatchFn := BuildDispatchAgentFunc(acc, NewDispatchRegistry(), 0, "")

	stub, err := dispatchFn(extension.DispatchAgentOpts{
		Name:       "term-err-agent",
		Task:       "fail durably",
		Background: true,
		OnError:    func(extension.DispatchError) { close(done) },
	})
	if err != nil {
		t.Fatalf("dispatch error: %v", err)
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for OnError callback")
	}

	ids := waitForPersist(t, acc)
	if len(ids) != 1 {
		t.Fatalf("PersistDispatchTerminal calls = %v, want exactly one", ids)
	}
	if ids[0] != stub.DispatchID {
		t.Errorf("persisted id = %q, want the dispatch's own id %q", ids[0], stub.DispatchID)
	}
}
