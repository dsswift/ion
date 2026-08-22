package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// cleanupRunExitJournal clears an accepted run's durable recovery journal when
// that run reaches a terminal exit. A suspended root retains its journal: its
// engine-owned wake has not started the next continuation yet.
func (m *Manager) cleanupRunExitJournal(
	exitSession *engineSession,
	key, runID string,
	suspendedExit, cleanCancel, abnormalExit bool,
	codeStr, sigStr string,
) {
	if exitSession == nil || suspendedExit {
		return
	}

	m.mu.Lock()
	current, live := m.sessions[key]
	isCurrent := live && current == exitSession
	recoveryActive := isCurrent && current.recoveryInProgress
	recoveryID, recoveryAttempt, recoveryMaxAttempts := "", 0, 0
	conversationID := ""
	if isCurrent {
		conversationID = current.conversationID
	}
	if recoveryActive {
		recoveryID, recoveryAttempt, recoveryMaxAttempts = current.recoveryID, current.recoveryAttempt, current.recoveryMaxAttempts
	}
	m.mu.Unlock()
	if !isCurrent {
		return
	}

	if !recoveryActive {
		// Ordinary runs have no recovery lifecycle state, but still own a
		// durable journal. Clear by request ID so a queued prompt's replacement
		// journal remains intact.
		cleared := m.clearRunRecovery(conversationID, key, runID, "run_exit")
		utils.LogWithFields(utils.LevelInfo, "session.recovery", "terminal run journal cleanup", map[string]any{"key": key, "conversation_id": conversationID, "run_id": runID, "journal_cleared": cleared})
		return
	}

	// Recovery runs additionally own lifecycle state and must publish their
	// recovery outcome after clearing their journal.
	phase, reason := "completed", ""
	if cleanCancel || abnormalExit {
		phase, reason = "failed", fmt.Sprintf("run exit code=%s signal=%s", codeStr, sigStr)
	}
	cleared := m.clearRunRecovery(conversationID, key, recoveryID, "run_exit")
	utils.LogWithFields(utils.LevelInfo, "session.recovery", "terminal recovery run journal cleanup", map[string]any{"key": key, "conversation_id": conversationID, "run_id": runID, "recovery_id": recoveryID, "journal_cleared": cleared})
	if !cleared {
		utils.LogWithFields(utils.LevelError, "session.recovery", "could not persist terminal recovery cleanup", map[string]any{"key": key, "conversation_id": conversationID, "phase": phase})
		phase, reason = "failed", "could not persist terminal recovery cleanup"
	}
	m.emitRunRecovery(key, recoveryID, phase, recoveryAttempt, recoveryMaxAttempts, reason)
	m.mu.Lock()
	if current, ok := m.sessions[key]; ok && current == exitSession && current.recoveryID == recoveryID {
		clearRecoveryLifecycle(current)
	}
	m.mu.Unlock()
}
