package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// StopSession cancels the active run and cleans up the session.
func (m *Manager) StopSession(key string) error {
	return m.stopSessionGuarded(key, nil)
}

// errStopGuardRefused reports that a guarded stop found the session no longer
// in the state its caller required.
var errStopGuardRefused = errors.New("stop refused by guard")

// stopSessionGuarded is StopSession with an optional precondition. guard runs
// under the same Manager.mu hold that removes the session, so a caller that
// decided to stop a session because of its state cannot race a change to that
// state. A non-empty guard result leaves the session untouched and returns
// errStopGuardRefused. A nil guard always stops.
func (m *Manager) stopSessionGuarded(key string, guard func(*engineSession) string) error {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if ok && guard != nil {
		if refusal := guard(s); refusal != "" {
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "stopsession: refused by guard", map[string]any{"key": key, "reason": refusal})
			return fmt.Errorf("session %q: %w: %s", key, errStopGuardRefused, refusal)
		}
	}
	if !ok {
		m.mu.Unlock()
		// DEBUG, and after the lookup, because a stop for an unknown key is not
		// a state transition — it is the expected answer to an idempotent retry.
		// Logged at INFO before the lookup, it made every no-op stop
		// indistinguishable from a real teardown: a misbehaving client produced
		// 109,801 INFO lines for roughly 60 actual stops, which rotated the log
		// past the window under investigation.
		utils.LogWithFields(utils.LevelDebug, "session", "stopsession for unknown key", map[string]any{"key": key})
		return fmt.Errorf("session %q not found", key)
	}
	utils.LogWithFields(utils.LevelInfo, "session", "stopsession", map[string]any{"key": key})
	// StartRun launches without Manager.mu so callbacks cannot deadlock. Record
	// an in-flight launch for cancellation after backend registration. StopSession
	// never waits here: a backend is allowed to synchronously invoke a callback,
	// and waiting from that callback would deadlock its StartRun frame.
	launchAck := s.launchAck
	launchingRunID := s.launchingRunID

	// Cancel the session's cancellation root so every descendant
	// operation (backend run, dispatched agents, in-flight llmCall) is
	// torn down with the session. Done before the explicit backend.Cancel
	// below; the two are complementary (root cascade for in-process work,
	// backend.Cancel for the per-run watchdog / terminal-status contract).
	// See session_root_context.go.
	s.cancelSessionRoot("stop session")

	// Halt the agent-state coalesce timer so a trailing flush cannot fire
	// against a session that is going away. Deliberately does NOT flush a
	// pending emission: teardown force-emits its own terminal snapshot, and
	// flushing here would race that with a staler view.
	if s.agentEmitter != nil {
		s.agentEmitter.stop()
	}

	// Cancel active run
	if s.requestID != "" {
		m.backend.Cancel(s.requestID)
		// Terminal point: clear the runID -> key routing binding alongside
		// requestID, under the lock StopSession already holds.
		m.unbindRunLocked(s.requestID)
		s.clearRunIdentity()
	} else if launchingRunID != "" {
		// Backend registration is outside Manager.mu. Cancel immediately after
		// StartRun acknowledges, even though this session has been removed.
		go func(runID string, ack <-chan struct{}) {
			<-ack
			m.backend.Cancel(runID)
			utils.LogWithFields(utils.LevelInfo, "session", "stopsession: cancelled run registered after stop", map[string]any{"key": key, "run_id": runID})
		}(launchingRunID, launchAck)
	}

	// Drop pending prompts
	s.promptQueue = nil

	// Kill child PIDs
	for pid := range s.childPIDs {
		killProcess(pid)
	}

	// Capture subsystems before deleting session
	resources := stoppedSessionResources{
		extGroup: s.extGroup, mcpConns: s.mcpConns, telemetry: s.telemetry,
		recorder: s.recorder, toolServer: s.toolServer,
		fsWatcherRelease: s.fsWatcherRelease, sessionMemory: s.sessionMemory,
		hookSettingsPath: s.hookSettingsPath,
		permHookServer:   s.permHookServer,
		conversationID:   s.conversationID,
		key:              key, session: s,
	}

	// conversation.* telemetry (issue #378, child 04): conversation.lifecycle
	// fires "detached" here, after the live session is successfully removed
	// from m.sessions below. No persistence check — detachment doesn't imply
	// durable persistence, unlike "deleted", which fires only after the
	// durable files are actually removed (see DeleteStoredExact's wiring).
	convID := s.conversationID
	extName := s.extensionName
	extVersion := s.extensionVersion

	delete(m.sessions, key)

	// Drop this session's skill registrations (see session_skills.go). Done
	// here alongside the session-map delete so a project's skills never
	// outlive the session that loaded them.
	clearSessionSkills(key)

	// If no remaining sessions use the same extension directory, purge all
	// runOnce entries for that extension. The debounce window only applies
	// while at least one session of the extension is alive. We check while
	// still holding the write lock so the count is authoritative.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		if hosts := s.extGroup.Hosts(); len(hosts) > 0 {
			extDir := hosts[0].ExtensionDir()
			if extDir != "" && m.extensionDirSessionCount(extDir) == 0 {
				resources.purgeExtensionDir = extDir
			}
		}
	}

	m.mu.Unlock()

	if convID != "" {
		ctx := conversationCorrelationCtx(key, convID, extName, extVersion, "", "")
		m.conversationEmitter().Lifecycle(ctx, convID, telemetry.ActionDetached, "")
	}

	m.finishStoppedSession(resources)
	return nil
}
