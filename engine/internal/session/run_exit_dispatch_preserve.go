package session

import "github.com/dsswift/ion/engine/internal/utils"

// preserveDispatchStatesLocked is handleRunExit's dispatch-state preservation
// step, split out to keep event_translation.go under the file-size cap.
// Call under m.mu.Lock() (handleRunExit already holds it). Returns bgCount,
// the count of live dispatch instances by ID, for the caller's logging.
//
// Preserve completed agent states (done/error/cancelled) so their
// conversation history survives for post-run inspection and tab
// persistence. Also preserve running states that correspond to active
// background dispatches — those agents are legitimately still running.
// Only clear running states that are stale (no live dispatch backing them).
//
// Preservation keys on BOTH the live dispatch IDs and names. The ID set
// covers engine-managed dispatch slots at every depth (the agent-state
// store keys those slots by their unique dispatch ID, and a nested
// depth-2+ dispatch's name collapses under name-only keying, so it would
// be swept and its terminal UpdateStateByID would land nowhere — the
// "agent stuck running" defect). The name set covers extension-roster
// rows that carry no engine dispatch ID. bgCount is the count of live
// dispatch instances (by ID), not distinct names.
func preserveDispatchStatesLocked(s *engineSession) int {
	if s.dispatchRegistry == nil {
		s.agents.ClearRunningStates()
		return 0
	}
	activeIDs := s.dispatchRegistry.ActiveIDs()
	activeNames := s.dispatchRegistry.ActiveNames()
	bgCount := len(activeIDs)
	if len(activeIDs) > 0 || len(activeNames) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: preserving live dispatch(es) by", map[string]any{"bg_count": bgCount, "run_id": activeIDs, "model": activeNames})
		s.agents.ClearRunningStatesExceptIDsOrNames(activeIDs, activeNames)
	} else {
		s.agents.ClearRunningStates()
	}
	return bgCount
}
