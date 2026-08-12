package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
)

// TestBoundProgressTargetSurvivesRunIdentityReplacement pins foreground Agent
// liveness ownership. A child can keep emitting after session status has cleared
// or replaced requestID; its credit must still reach the run that opened the
// foreground wait, never whichever run happens to own the session slot later.
func TestBoundProgressTargetSurvivesRunIdentityReplacement(t *testing.T) {
	backend := newMockBackend()
	manager := NewManager(backend)
	defer manager.Shutdown()

	session := &engineSession{
		key:              "bound-progress",
		requestID:        "root-run-original",
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	manager.mu.Lock()
	manager.sessions[session.key] = session
	manager.mu.Unlock()

	accessor := &sessionAccessor{
		m:              manager,
		s:              session,
		key:            session.key,
		progressTarget: manager.progressTarget("root-run-original"),
	}

	// Simulate status reconciliation observing a new run before delayed child
	// activity reaches the parent dispatch callback.
	session.setRunIdentity("root-run-replacement", "trace-replacement")
	accessor.BumpParentProgress()

	if got := backend.progressBumpCount("root-run-original"); got != 1 {
		t.Fatalf("original run progress bumps = %d, want 1", got)
	}
	if got := backend.progressBumpCount("root-run-replacement"); got != 0 {
		t.Fatalf("replacement run progress bumps = %d, want 0", got)
	}
}
