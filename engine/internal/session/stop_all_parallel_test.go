package session

import (
	"fmt"
	"testing"
)

// StopAll must still stop every session — the contract the parallel teardown
// had to preserve.
func TestStopAll_StopsEverySession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	for i := 0; i < 25; i++ {
		if _, err := mgr.StartSession(fmt.Sprintf("s-%d", i), defaultConfig()); err != nil {
			t.Fatalf("StartSession %d: %v", i, err)
		}
	}

	if err := mgr.StopAll(); err != nil {
		t.Fatalf("StopAll: %v", err)
	}

	if got := len(mgr.ListSessions()); got != 0 {
		t.Errorf("sessions after StopAll: got %d want 0", got)
	}
}

// StopAll returns only once every teardown has finished. Without the WaitGroup
// join, shutdown would race ahead of in-flight teardown and the process would
// exit mid-session-end — a worse version of the bug the bound was added for.
func TestStopAllSessions_WaitsForEveryTeardown(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	keys := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		k := fmt.Sprintf("s-%d", i)
		keys = append(keys, k)
		if _, err := mgr.StartSession(k, defaultConfig()); err != nil {
			t.Fatalf("StartSession %s: %v", k, err)
		}
	}

	mgr.stopAllSessions(keys)

	// Every key must be gone from the manager by the time stopAllSessions
	// returns; a key still present means its teardown had not completed.
	live := map[string]bool{}
	for _, k := range mgr.SessionKeys() {
		live[k] = true
	}
	for _, k := range keys {
		if live[k] {
			t.Errorf("session %q still live after stopAllSessions returned", k)
		}
	}
}

// An empty session set is the ordinary case for an idle daemon: it must not
// deadlock on the unbuffered work channel or spin up workers.
func TestStopAllSessions_EmptyIsANoOp(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.stopAllSessions(nil)
	mgr.stopAllSessions([]string{})
}

// More sessions than workers must all be drained, not just the first batch.
func TestStopAllSessions_DrainsMoreSessionsThanWorkers(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	total := stopAllConcurrency * 3
	keys := make([]string, 0, total)
	for i := 0; i < total; i++ {
		k := fmt.Sprintf("s-%d", i)
		keys = append(keys, k)
		if _, err := mgr.StartSession(k, defaultConfig()); err != nil {
			t.Fatalf("StartSession %s: %v", k, err)
		}
	}

	mgr.stopAllSessions(keys)

	if got := len(mgr.ListSessions()); got != 0 {
		t.Errorf("sessions after draining %d keys with %d workers: got %d want 0", total, stopAllConcurrency, got)
	}
}
