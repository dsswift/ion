package session

import (
	"encoding/json"
	"errors"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (m *Manager) recoveryEnabled(cfg *types.EngineConfig) bool {
	if cfg.RunRecovery != nil && cfg.RunRecovery.Enabled != nil {
		return *cfg.RunRecovery.Enabled
	}
	if m.config != nil && m.config.RunRecovery != nil && m.config.RunRecovery.Enabled != nil {
		return *m.config.RunRecovery.Enabled
	}
	return false
}

func (m *Manager) recoveryMaxAttempts(cfg *types.EngineConfig) int {
	if cfg.RunRecovery != nil && cfg.RunRecovery.MaxAttempts > 0 {
		return cfg.RunRecovery.MaxAttempts
	}
	if m.config != nil && m.config.RunRecovery != nil && m.config.RunRecovery.MaxAttempts > 0 {
		return m.config.RunRecovery.MaxAttempts
	}
	return types.RunRecoveryDefaultMaxAttempts
}

func recoveryOverrides(overrides *PromptOverrides) json.RawMessage {
	if overrides == nil {
		return nil
	}
	data, err := json.Marshal(overrides)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.recovery", "could not encode prompt overrides for recovery", map[string]any{"error": err.Error()})
		return nil
	}
	return data
}

// recordRunRecovery commits the user turn and journal through the conversation
// ownership funnel. It never performs an independent Load/Save cycle.
func (m *Manager) recordRunRecovery(s *engineSession, key, requestID string, opts types.RunOptions, overrides *PromptOverrides) (string, bool) {
	if !m.recoveryEnabled(&s.config) || s.conversationID == "" {
		return "", true
	}
	var userEntryID string
	err := conversation.UpdateOrCreateOnDisk(s.conversationID, "", func() *conversation.Conversation {
		return conversation.CreateConversation(s.conversationID, "", opts.Model)
	}, func(conv *conversation.Conversation) (bool, error) {
		userEntry := backend.AppendInboundUserMessage(conv, &opts)
		if userEntry != nil {
			userEntryID = userEntry.ID
		}
		conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
			RecoveryID: requestID, SessionKey: key, Prompt: opts.Prompt, Model: opts.Model,
			Overrides: recoveryOverrides(overrides), UserEntryID: userEntryID,
			CheckpointID: conversation.CurrentLeafID(conv),
		})
		return true, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.recovery", "could not persist active run journal", map[string]any{"key": key, "conversation_id": s.conversationID, "error": err.Error()})
		return "", false
	}
	utils.LogWithFields(utils.LevelInfo, "session.recovery", "persisted accepted user turn and active run journal", map[string]any{"key": key, "conversation_id": s.conversationID, "user_entry_id": userEntryID})
	return userEntryID, true
}

// clearRunRecovery removes a journal only when it still belongs to recoveryID.
// Empty recoveryID retains explicit-stop behavior and clears any active journal.
func (m *Manager) clearRunRecovery(conversationID, key string, args ...string) bool {
	recoveryID, reason := "", ""
	if len(args) == 1 {
		reason = args[0]
	}
	if len(args) >= 2 {
		recoveryID, reason = args[0], args[1]
	}
	if conversationID == "" {
		return true
	}
	cleared := false
	err := conversation.UpdateOnDisk(conversationID, "", func(conv *conversation.Conversation) (bool, error) {
		journal := conversation.ActiveRunRecovery(conv)
		if journal == nil {
			return false, nil
		}
		if recoveryID != "" && journal.RecoveryID != recoveryID {
			return false, nil
		}
		if recoveryID == "" {
			conversation.ClearRunRecovery(conv)
		} else {
			cleared = conversation.ClearRunRecoveryIf(conv, recoveryID)
		}
		if recoveryID == "" {
			cleared = true
		}
		return cleared, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.recovery", "could not clear active run journal", map[string]any{"key": key, "conversation_id": conversationID, "reason": reason, "error": err.Error()})
		return false
	}
	if cleared {
		utils.LogWithFields(utils.LevelInfo, "session.recovery", "cleared active run journal", map[string]any{"key": key, "conversation_id": conversationID, "reason": reason})
	}
	return true
}

// clearRecoveryLifecycle requires Manager.mu. Recovery fields are manager-owned.
func clearRecoveryLifecycle(s *engineSession) {
	s.recoveryInProgress, s.recoveryID = false, ""
	s.recoveryAttempt, s.recoveryMaxAttempts = 0, 0
}

// recoverInterruptedRun claims a durable journal before it schedules its
// continuation. Disk and extension work stays outside Manager.mu; commits are
// revalidated against the same session pointer and journal identity.
func (m *Manager) recoverInterruptedRun(s *engineSession, key string) bool {
	if !m.recoveryEnabled(&s.config) || s.conversationID == "" {
		return false
	}
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		if !errors.Is(err, conversation.ErrNotFound) {
			utils.LogWithFields(utils.LevelWarn, "session.recovery", "could not load recovery journal", map[string]any{"key": key, "conversation_id": s.conversationID, "error": err.Error()})
		}
		return false
	}
	journal := conversation.ActiveRunRecovery(conv)
	if journal == nil {
		return false
	}
	maxAttempts := m.recoveryMaxAttempts(&s.config)
	if journal.AttemptCount >= maxAttempts {
		if m.clearRunRecovery(s.conversationID, key, journal.RecoveryID, "exhausted") {
			m.emitRunRecovery(key, journal.RecoveryID, "exhausted", journal.AttemptCount, maxAttempts, "automatic recovery attempt limit reached")
		}
		return false
	}

	instruction := conversation.RecoveryContinuationPrompt()
	if s.extGroup != nil {
		decision := s.extGroup.FireBeforeRunRecovery(m.newExtContext(s, key), extension.BeforeRunRecoveryInfo{RecoveryID: journal.RecoveryID, ConversationID: s.conversationID, Attempt: journal.AttemptCount + 1, MaxAttempts: maxAttempts, Prompt: journal.Prompt, Model: journal.Model, SessionKey: key})
		if decision != nil {
			if decision.Action == "skip" {
				if m.clearRunRecovery(s.conversationID, key, journal.RecoveryID, "extension_skip") {
					m.emitRunRecovery(key, journal.RecoveryID, "skipped", journal.AttemptCount, maxAttempts, "extension skipped recovery")
				}
				return false
			}
			if decision.Instruction != "" {
				instruction = decision.Instruction
			}
		}
	}

	var attempted *conversation.RunJournalEntry
	err = conversation.UpdateOnDisk(s.conversationID, "", func(c *conversation.Conversation) (bool, error) {
		current := conversation.ActiveRunRecovery(c)
		if current == nil || current.RecoveryID != journal.RecoveryID {
			return false, nil
		}
		attempted = conversation.MarkRunRecoveryAttempt(c)
		return attempted != nil, nil
	})
	if err != nil || attempted == nil {
		reason := "recovery journal changed before attempt"
		if err != nil {
			reason = "could not persist recovery attempt"
			utils.LogWithFields(utils.LevelError, "session.recovery", reason, map[string]any{"key": key, "conversation_id": s.conversationID, "error": err.Error()})
		}
		m.emitRunRecovery(key, journal.RecoveryID, "failed", journal.AttemptCount, maxAttempts, reason)
		return false
	}

	m.mu.Lock()
	current, ok := m.sessions[key]
	if !ok || current != s || current.conversationID != s.conversationID || current.recoveryInProgress {
		m.mu.Unlock()
		return false
	}
	current.recoveryInProgress, current.recoveryID = true, attempted.RecoveryID
	current.recoveryAttempt, current.recoveryMaxAttempts = attempted.AttemptCount, maxAttempts
	m.mu.Unlock()
	m.emitRunRecovery(key, attempted.RecoveryID, "started", attempted.AttemptCount, maxAttempts, "")
	m.enqueueRecovery(key, attempted.RecoveryID, func() {
		m.mu.RLock()
		current, ok := m.sessions[key]
		owns := ok && current == s && current.recoveryInProgress && current.recoveryID == attempted.RecoveryID
		m.mu.RUnlock()
		if !owns {
			utils.LogWithFields(utils.LevelInfo, "session.recovery", "recovery queue job cancelled before dispatch", map[string]any{"key": key, "recovery_id": attempted.RecoveryID})
			return
		}
		m.dispatchRecoveredRun(s, key, s.conversationID, instruction, attempted, maxAttempts)
	})
	return true
}

func (m *Manager) dispatchRecoveredRun(source *engineSession, key, conversationID, instruction string, journal *conversation.RunJournalEntry, maxAttempts int) {
	overrides := &PromptOverrides{InjectionKind: string(types.InjectionKindRunRecovery)}
	if len(journal.Overrides) > 0 {
		if err := json.Unmarshal(journal.Overrides, overrides); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.recovery", "could not restore prompt overrides; using safe continuation defaults", map[string]any{"key": key, "conversation_id": conversationID, "error": err.Error()})
			overrides = &PromptOverrides{}
		}
	}
	overrides.InjectionKind, overrides.ResolveSlash = string(types.InjectionKindRunRecovery), false
	if err := m.SendPrompt(key, instruction, overrides); err != nil {
		if m.clearRecoveredRun(source, key, conversationID, journal.RecoveryID, "continuation_dispatch_failed") {
			m.emitRunRecovery(key, journal.RecoveryID, "failed", journal.AttemptCount, maxAttempts, err.Error())
		}
		utils.LogWithFields(utils.LevelError, "session.recovery", "continuation dispatch failed", map[string]any{"key": key, "conversation_id": conversationID, "error": err.Error()})
		return
	}
	if m.recoveredRunDidNotStart(source, key, journal.RecoveryID) && m.clearRecoveredRun(source, key, conversationID, journal.RecoveryID, "continuation_not_started") {
		m.emitRunRecovery(key, journal.RecoveryID, "failed", journal.AttemptCount, maxAttempts, "recovery continuation did not start a run")
	}
}

func (m *Manager) recoveredRunDidNotStart(source *engineSession, key, recoveryID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	current, ok := m.sessions[key]
	return ok && current == source && current.recoveryID == recoveryID && current.requestID == ""
}

func (m *Manager) clearRecoveredRun(source *engineSession, key, conversationID, recoveryID, reason string) bool {
	m.mu.RLock()
	current, ok := m.sessions[key]
	owns := ok && current == source && current.recoveryID == recoveryID
	m.mu.RUnlock()
	if !owns {
		return false
	}
	cleared := m.clearRunRecovery(conversationID, key, recoveryID, reason)
	m.mu.Lock()
	if current, ok := m.sessions[key]; ok && current == source && current.recoveryID == recoveryID {
		clearRecoveryLifecycle(current)
	}
	m.mu.Unlock()
	return cleared
}

func (m *Manager) emitRunRecovery(key, recoveryID, phase string, attempt, maxAttempts int, reason string) {
	m.emit(key, types.EngineEvent{Type: "engine_run_recovery", RunRecoveryID: recoveryID, RunRecoveryPhase: phase, RunRecoveryAttempt: attempt, RunRecoveryMaxAttempts: maxAttempts, RunRecoveryReason: reason})
}

func (m *Manager) handleStopRecovery(conversationID, key string) {
	m.mu.RLock()
	shuttingDown := m.shuttingDown
	s := m.sessions[key]
	var recoveryID string
	if s != nil {
		recoveryID = s.recoveryID
	}
	m.mu.RUnlock()
	if shuttingDown {
		utils.LogWithFields(utils.LevelInfo, "session.recovery", "preserving active run journal during shutdown", map[string]any{"key": key, "conversation_id": conversationID})
		return
	}
	m.clearRunRecovery(conversationID, key, recoveryID, "explicit_stop")
	m.mu.Lock()
	if s2, ok := m.sessions[key]; ok && s2 == s {
		clearRecoveryLifecycle(s2)
	}
	m.mu.Unlock()
}
