package session

// currentModel returns the session's resolved model snapshot. Model metadata is
// read while extension contexts are built on background dispatch goroutines, so
// it cannot rely only on Manager.mu: several context-construction paths already
// hold that non-reentrant lock. modelMu provides independent synchronization.
func (s *engineSession) currentModel() string {
	s.modelMu.RLock()
	defer s.modelMu.RUnlock()
	return s.lastModel
}

func (s *engineSession) setCurrentModel(model string) {
	s.modelMu.Lock()
	s.lastModel = model
	s.modelMu.Unlock()
}
