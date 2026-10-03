// idle_release.go — releasing a session that has nothing left to do.
//
// A session is quiescent when no mechanism inside the engine will act on it
// again: no run, no accepted work pending, no agent still running, no live
// background process, no schedule or webhook that could fire into it. Left
// alone it stays resident for the life of the daemon, holding its extension
// subprocesses and MCP connections, and every heartbeat re-serialises agent
// records that reached a terminal status long ago.
//
// Two triggers release a quiescent session, both through the same teardown
// stop_session performs:
//
//   - Timed. The heartbeat tick measures how long each session has been
//     continuously quiescent and releases one that outlasts the limit.
//   - Abort. A wire abort (scope all or all_work) for a session that was
//     already quiescent has nothing to abort, so it releases instead.
//
// How long to wait, and whether an idle abort releases, are opinions: both are
// config (workspace.sessionIdleReleaseMs, workspace.releaseIdleSessionOnAbort),
// and the session_before_release hook lets a harness keep any individual
// session.
package session

import (
	"errors"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const idleReleaseLogTag = "session.idle_release"

// OnSessionReleased registers a callback told about each engine-initiated
// release, after the session is gone. It lets the layer above drop per-key
// state it would otherwise have dropped while handling stop_session.
func (m *Manager) OnSessionReleased(fn func(key, reason string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onSessionReleased = fn
}

// workspaceConfig returns the workspace block, nil when unset. Its accessors
// resolve a nil receiver to the compiled defaults.
func (m *Manager) workspaceConfig() *types.WorkspaceConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config.GetWorkspace()
}

// quiescenceBlockerLocked names what keeps the session from being quiescent,
// or returns "" when nothing under Manager.mu does. Caller holds m.mu for
// writing: computing the run state can clear a stale request id.
func (m *Manager) quiescenceBlockerLocked(s *engineSession) string {
	switch {
	case s.settled:
		// A settled session is a consumer's explicit pause. Releasing it
		// would make its resume fail.
		return "settled"
	case m.currentSessionStatus(s) != "idle":
		return "run_active"
	case s.launchingRunID != "":
		return "run_launching"
	case s.compactInFlight:
		return "compacting"
	}
	dispatches := 0
	if s.dispatchRegistry != nil {
		dispatches = len(s.dispatchRegistry.ActiveIDs())
	}
	if sessionHasPendingWork(s, dispatches) {
		return "pending_work"
	}
	// Teardown kills session-owned background processes and child PIDs, so a
	// live one is work the session is still responsible for.
	if len(liveBackgroundTaskStates(s.key)) > 0 {
		return "background_tasks"
	}
	if len(s.childPIDs) > 0 {
		return "child_processes"
	}
	for _, agent := range s.agents.MergedSnapshot() {
		if agent.Status == "running" {
			return "agent_running"
		}
	}
	return ""
}

// asyncRegistrationBlocker reports whether any of the group's hosts holds a
// schedule or webhook. Such a session is waiting on an external trigger and is
// not quiescent. Called without Manager.mu: the registry has its own lock.
func asyncRegistrationBlocker(group *extension.ExtensionGroup) string {
	if group == nil || group.IsEmpty() {
		return ""
	}
	for _, host := range group.Hosts() {
		if len(host.Schedules()) > 0 || len(host.Webhooks()) > 0 {
			return "async_registrations"
		}
	}
	return ""
}

// quiescenceBlocker resolves the session and what, if anything, keeps it from
// being quiescent. ok is false when no session exists for key.
func (m *Manager) quiescenceBlocker(key string) (s *engineSession, blocker string, ok bool) {
	m.mu.Lock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return nil, "", false
	}
	blocker = m.quiescenceBlockerLocked(s)
	group := s.extGroup
	m.mu.Unlock()

	if blocker == "" {
		blocker = asyncRegistrationBlocker(group)
	}
	return s, blocker, true
}

// evaluateIdleRelease advances one session's idle clock and releases the
// session when it has been quiescent longer than the limit. Reports whether
// the session was released.
func (m *Manager) evaluateIdleRelease(key string, now time.Time) bool {
	after, timed := m.workspaceConfig().SessionIdleRelease()
	s, blocker, ok := m.quiescenceBlocker(key)
	if !ok {
		return false
	}

	m.mu.Lock()
	if m.sessions[key] != s {
		m.mu.Unlock()
		return false
	}
	if blocker != "" {
		if !s.quiescentSince.IsZero() {
			utils.LogWithFields(utils.LevelDebug, idleReleaseLogTag, "idle clock reset", map[string]any{"key": key, "blocker": blocker})
			s.quiescentSince = time.Time{}
		}
		m.mu.Unlock()
		return false
	}
	if s.quiescentSince.IsZero() {
		s.quiescentSince = now
		utils.LogWithFields(utils.LevelDebug, idleReleaseLogTag, "idle clock started", map[string]any{"key": key})
	}
	idle := now.Sub(s.quiescentSince)
	m.mu.Unlock()

	if !timed || idle < after {
		return false
	}
	return m.releaseQuiescentSession(key, s, extension.SessionReleaseReasonIdleTimeout, idle)
}

// AbortOrRelease is the wire abort. It performs SendAbortScoped, and when the
// session was already quiescent — so the abort had nothing to stop — releases
// the session instead of leaving it resident. Reports whether it released.
//
// Quiescence is read before the abort so the decision cannot depend on how far
// the abort's own teardown has progressed. The orchestrator scope never
// releases: its contract is to leave the session root live.
//
// Kept apart from SendAbortScoped because that is also reached from inside an
// extension hook (ctx.abort), where tearing down the calling extension's own
// session mid-call is not what an abort means.
func (m *Manager) AbortOrRelease(key string, scope AbortScope) bool {
	onAbort := m.workspaceConfig().ReleaseIdleSessionOnAbortEnabled()
	s, blocker, ok := m.quiescenceBlocker(key)
	var idle time.Duration
	if ok {
		m.mu.RLock()
		if !s.quiescentSince.IsZero() {
			idle = time.Since(s.quiescentSince)
		}
		m.mu.RUnlock()
	}

	m.SendAbortScoped(key, scope)

	switch {
	case !ok:
		return false
	case scope == AbortScopeOrchestrator:
		return false
	case !onAbort:
		utils.LogWithFields(utils.LevelDebug, idleReleaseLogTag, "abort: release on idle abort disabled, session retained", map[string]any{"key": key, "abort_scope": string(scope)})
		return false
	case blocker != "":
		utils.LogWithFields(utils.LevelDebug, idleReleaseLogTag, "abort: session had work, retained", map[string]any{"key": key, "abort_scope": string(scope), "blocker": blocker})
		return false
	}
	return m.releaseQuiescentSession(key, s, extension.SessionReleaseReasonIdleAbort, idle)
}

// releaseQuiescentSession offers the release to the session's extensions and,
// unless one keeps the session, stops it. Callers must not hold Manager.mu.
func (m *Manager) releaseQuiescentSession(key string, s *engineSession, reason string, idle time.Duration) bool {
	fields := map[string]any{"key": key, "reason": reason, "idle_ms": idle.Milliseconds(), "conversation_id": s.conversationID}

	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		keep, err := s.extGroup.FireSessionBeforeRelease(m.newExtContext(s, key), extension.SessionReleaseInfo{
			Reason: reason, IdleMs: idle.Milliseconds(),
		})
		if err != nil {
			// A failing handler expressed no opinion; the release proceeds.
			utils.LogWithFields(utils.LevelWarn, idleReleaseLogTag, "session_before_release hook failed, releasing", map[string]any{"key": key, "reason": reason, "error": err.Error()})
		}
		if keep {
			// Restart the clock so the hook is asked again after another full
			// period rather than on every tick.
			m.mu.Lock()
			if m.sessions[key] == s {
				s.quiescentSince = time.Now()
			}
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, idleReleaseLogTag, "release kept by session_before_release hook", fields)
			return false
		}
	}

	// The hook ran without the lock, so work may have arrived meanwhile. The
	// guard re-checks under the lock hold that removes the session.
	err := m.stopSessionGuarded(key, func(cur *engineSession) string {
		if cur != s {
			return "session replaced"
		}
		return m.quiescenceBlockerLocked(cur)
	})
	switch {
	case errors.Is(err, errStopGuardRefused):
		utils.LogWithFields(utils.LevelInfo, idleReleaseLogTag, "release abandoned, session no longer quiescent", fields)
		return false
	case err != nil:
		utils.LogWithFields(utils.LevelInfo, idleReleaseLogTag, "release found no session", map[string]any{"key": key, "reason": reason, "error": err.Error()})
		return false
	}

	utils.LogWithFields(utils.LevelInfo, idleReleaseLogTag, "session released", fields)
	m.mu.RLock()
	released := m.onSessionReleased
	m.mu.RUnlock()
	if released != nil {
		released(key, reason)
	}
	return true
}
