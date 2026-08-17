package session

import "testing"

func TestNewSessionHasNoRecoveryLifecycleState(t *testing.T) {
	_, s, _ := recoveryTestManager(t, true)
	if s.recoveryInProgress || s.recoveryID != "" || s.recoveryAttempt != 0 || s.recoveryMaxAttempts != 0 {
		t.Fatalf("new session has recovery state: %+v", s)
	}
}
