package session

// setRunIdentity updates one run's paired identifiers. Callers hold Manager.mu
// when the session is manager-owned; runIdentityMu also protects snapshots made
// by extension-context construction after manager lock release.
func (s *engineSession) setRunIdentity(runID, traceID string) {
	s.runIdentityMu.Lock()
	s.requestID = runID
	s.runTraceID = traceID
	s.runIdentityMu.Unlock()
}

func (s *engineSession) clearRunIdentity() {
	s.setRunIdentity("", "")
}

// clearRunIdentityFor clears only the run that still owns the session slot.
// Callers use this after work outside Manager.mu, where a newer run may already
// have started and must not be erased by the older run's cleanup.
func (s *engineSession) clearRunIdentityFor(runID string) bool {
	s.runIdentityMu.Lock()
	defer s.runIdentityMu.Unlock()
	if s.requestID != runID {
		return false
	}
	s.requestID = ""
	s.runTraceID = ""
	return true
}

func (s *engineSession) runIdentitySnapshot() (string, string) {
	s.runIdentityMu.RLock()
	defer s.runIdentityMu.RUnlock()
	return s.requestID, s.runTraceID
}
