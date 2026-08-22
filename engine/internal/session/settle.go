// settle.go — pause and resume a session's async subsystems without
// destroying it.
//
// SettleSession cancels any active run and unwires async hosts (schedules,
// webhooks) so nothing fires while the session is settled. The session
// stays in the Manager's map; StartSession for the same key remains
// idempotent. Extension subprocesses and MCP connections stay alive.
//
// ResumeSession reverses the settle: re-wires async hosts so schedules
// and webhooks begin firing again, and clears the settled flag so
// prompts are accepted.
//
// The mechanism is generic and UI-agnostic: the desktop's "inbox settle"
// is one consumer, but any client (iOS, CLI, custom harness) can pause
// and resume a session through the same wire commands.

package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SettleSession pauses a live session without destroying it.
//
// Effects:
//   - Cancels any in-flight run (same as the first half of StopSession).
//   - Unwires async hosts so the scheduler and webhook server stop
//     dispatching to this session's extension hosts.
//   - Sets s.settled = true, which gates SendPrompt and the async
//     session resolver.
//   - Emits engine_status with state "settled" so clients can update.
//
// A settled session can be resumed via ResumeSession or fully torn down
// via StopSession. Calling SettleSession on an already-settled session
// is idempotent.
func (m *Manager) SettleSession(key string) error {
	utils.LogWithFields(utils.LevelInfo, "session", "settlesession", map[string]any{"key": key})
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", key)
	}
	if s.settled {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session", "settlesession: already settled", map[string]any{"key": key})
		return nil
	}

	// Cancel the session's cancellation root so in-flight work stops.
	s.cancelSessionRoot("settle session")

	// Halt the agent-state coalesce timer.
	if s.agentEmitter != nil {
		s.agentEmitter.stop()
	}

	// Cancel active run (mirrors the StopSession logic).
	if s.requestID != "" {
		m.backend.Cancel(s.requestID)
		m.unbindRunLocked(s.requestID)
		s.clearRunIdentity()
	}

	// Drop pending prompts — they belong to the pre-settle lifecycle.
	s.promptQueue = nil

	s.settled = true
	m.mu.Unlock()

	// Unwire async hosts outside the lock (mirrors StopSession ordering).
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		for _, host := range s.extGroup.Hosts() {
			m.unwireHostAsync(host)
		}
	}

	m.emitStatusSnapshot(key, "settle_session")
	utils.LogWithFields(utils.LevelInfo, "session", "settlesession: complete", map[string]any{"key": key})
	return nil
}

// rejectIfSettled checks whether s is settled and, if so, emits an
// engine_error event and returns a non-nil error. The caller must hold
// m.mu on entry; if the session is settled the lock is released before
// returning. On a nil return the lock is still held.
func (m *Manager) rejectIfSettled(key string, s *engineSession) error {
	if !s.settled {
		return nil
	}
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt: rejected (session settled)", map[string]any{"key": key})
	m.emit(key, types.EngineEvent{
		Type:         "engine_error",
		EventMessage: fmt.Sprintf("session %q is settled; resume before sending prompts", key),
		ErrorCode:    "session_settled",
	})
	return fmt.Errorf("session %q is settled", key)
}

// ResumeSession reverses a settle, restoring the session to active duty.
//
// Effects:
//   - Allocates a fresh session root context so new runs and dispatches
//     can derive from it.
//   - Re-wires async hosts so schedules and webhooks resume.
//   - Clears s.settled so prompts are accepted again.
//   - Emits engine_status with state "idle" so clients can update.
//
// Calling ResumeSession on a session that is not settled returns an
// error. A resumed session is ready to receive prompts immediately.
func (m *Manager) ResumeSession(key string) error {
	utils.LogWithFields(utils.LevelInfo, "session", "resumesession", map[string]any{"key": key})
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", key)
	}
	if !s.settled {
		m.mu.Unlock()
		return fmt.Errorf("session %q is not settled", key)
	}

	// Fresh cancellation root for the resumed lifecycle.
	s.newSessionRootContext()

	// Re-initialize the agent emitter so status emissions work again.
	s.agentEmitter = &agentEmitter{}

	s.settled = false
	m.mu.Unlock()

	// Re-wire async hosts so schedules and webhooks resume firing.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		for _, host := range s.extGroup.Hosts() {
			m.wireHostAsync(key, host)
		}
	}

	m.emitStatusSnapshot(key, "resume_session")
	utils.LogWithFields(utils.LevelInfo, "session", "resumesession: complete", map[string]any{"key": key})
	return nil
}
