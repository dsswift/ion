package session

// TrackRootDispatch keeps a top-level child identity alive from launch through
// its terminal callback. The dispatch registry deregisters before that callback,
// so a full stop needs this separate record to reject a late completion.
func (a *sessionAccessor) TrackRootDispatch(dispatchID string) {
	if dispatchID == "" {
		return
	}
	a.m.mu.Lock()
	defer a.m.mu.Unlock()
	if current, ok := a.m.sessions[a.key]; ok && current == a.s {
		if current.rootDispatchesStopped {
			if current.stoppedRootDispatchIDs == nil {
				current.stoppedRootDispatchIDs = make(map[string]struct{})
			}
			current.stoppedRootDispatchIDs[dispatchID] = struct{}{}
			return
		}
		if current.rootDispatchIDs == nil {
			current.rootDispatchIDs = make(map[string]struct{})
		}
		current.rootDispatchIDs[dispatchID] = struct{}{}
	}
}
