package session

import "testing"

// TestRunIDsUniqueWithinAMillisecond pins run-id uniqueness as a contract
// rather than as a test-setup assumption.
//
// RED on the unfixed code: the id was `<key>-<unix millis>`, so two runs of one
// session that started inside the same millisecond shared it. A run id is an
// identity — it keys the active-run map, scopes an abort, correlates the run's
// log lines, and de-duplicates the persisted stop marker — so a collision makes
// the second run adopt the first one's history. On a fast machine this loop
// completes several runs per millisecond.
func TestRunIDsUniqueWithinAMillisecond(t *testing.T) {
	mgr := NewManager(newMockBackend())
	const key = "run-id-uniqueness"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	seen := map[string]int{}
	for i := 0; i < 25; i++ {
		if err := mgr.SendPrompt(key, "prompt", nil); err != nil {
			t.Fatalf("SendPrompt %d: %v", i, err)
		}
		mgr.mu.Lock()
		runID := mgr.sessions[key].requestID
		mgr.mu.Unlock()
		if prior, dup := seen[runID]; dup {
			t.Fatalf("run %d reused the run id %q first minted by run %d", i, runID, prior)
		}
		seen[runID] = i
		mgr.handleRunExit(runID, intPtr(0), nil, "")
	}
}
