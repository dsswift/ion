package session

import (
	"fmt"
	"sync"
	"testing"
)

// TestSessionAccessorRunIdentityConcurrentClear pins extension-context identity
// reads against run-exit writes. A context must observe one coherent pair and
// race-detector execution must remain clean while lifecycle code clears or
// replaces that pair.
func TestSessionAccessorRunIdentityConcurrentClear(t *testing.T) {
	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	const key = "run-identity-race"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	mgr.mu.Unlock()
	accessor := &sessionAccessor{m: mgr, s: s, key: key}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			mgr.mu.Lock()
			runID := fmt.Sprintf("run-%d", i)
			s.setRunIdentity(runID, "trace-"+runID)
			if i%2 == 0 {
				s.clearRunIdentityFor(runID)
			}
			mgr.mu.Unlock()
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			runID, traceID := accessor.RunIdentity()
			if runID == "" {
				if traceID != "" {
					t.Errorf("idle identity carried trace %q", traceID)
				}
				continue
			}
			if traceID != "trace-"+runID {
				t.Errorf("incoherent run identity: run=%q trace=%q", runID, traceID)
			}
		}
	}()
	wg.Wait()
}
