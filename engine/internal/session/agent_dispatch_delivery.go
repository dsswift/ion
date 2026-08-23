package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// deliverRootDispatchResult records every terminal root-owned dispatch before
// attempting prompt delivery. Queue backpressure retains the FIFO record for a
// retry after a run exits or a prompt leaves the queue.
func (m *Manager) deliverRootDispatchResult(key string, result extension.DispatchAgentResult) {
	record := rootDispatchCompletion{
		DeliveryID: fmt.Sprintf("root-completion-%d-%s", time.Now().UnixNano(), result.DispatchID),
		Text:       formatRootDispatchResult(result),
		DispatchID: result.DispatchID,
		Name:       result.Name,
		ExitCode:   result.ExitCode,
		ElapsedMs:  int64(result.Elapsed * 1000),
	}
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.rootDispatchCompletions = append(s.rootDispatchCompletions, record)
		if err := persistRootDispatchOutbox(s.conversationID, s.rootDispatchCompletions); err != nil {
			s.rootDispatchCompletions = s.rootDispatchCompletions[:len(s.rootDispatchCompletions)-1]
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelError, "session.dispatch_delivery", "root dispatch completion outbox persistence failed", map[string]any{
				"session_id": key, "delivery_id": record.DeliveryID, "dispatch_id": record.DispatchID, "error": err.Error(),
			})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "session.dispatch_delivery", "root dispatch completion recorded", map[string]any{
			"session_id": key, "delivery_id": record.DeliveryID, "dispatch_id": record.DispatchID,
			"model": record.Name, "exit_code": record.ExitCode, "pending": len(s.rootDispatchCompletions),
		})
	} else {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session.dispatch_delivery", "root dispatch completion dropped for missing session", map[string]any{
			"session_id": key, "dispatch_id": record.DispatchID, "model": record.Name,
		})
		return
	}
	m.mu.Unlock()
	m.retryRootDispatchCompletions(key)
}

// retryRootDispatchCompletions delivers FIFO head only. A successful SendPrompt
// has inserted the classified completion into the ordinary prompt path, so the
// head can be acknowledged. An error leaves it untouched for the next retry.
func (m *Manager) retryRootDispatchCompletions(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || len(s.rootDispatchCompletions) == 0 {
		m.mu.RUnlock()
		return
	}
	record := s.rootDispatchCompletions[0]
	m.mu.RUnlock()

	// Do not put a completion ahead of user input already accepted into the
	// session FIFO. Retry after its dequeue/run exit instead.
	m.mu.RLock()
	queuedUserPrompt := len(s.promptQueue) > 0
	m.mu.RUnlock()
	if queuedUserPrompt {
		return
	}

	overrides := buildPromptOverrides("", nil, string(types.InjectionKindAgentCompletion))
	overrides.BackgroundWork = types.BackgroundWorkInfo{
		Kind: string(types.InjectionKindAgentCompletion), DeliveryMode: "wake",
		Items: []types.BackgroundWorkItem{{
			ID: record.DispatchID, Source: types.BackgroundWorkSourceAgent, Label: record.Name,
			Status: rootDispatchStatus(record.ExitCode), ExitCode: record.ExitCode, ElapsedMs: record.ElapsedMs,
		}},
	}
	if err := m.SendPrompt(key, record.Text, overrides); err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.dispatch_delivery", "root dispatch completion remains queued", map[string]any{
			"session_id": key, "delivery_id": record.DeliveryID, "dispatch_id": record.DispatchID,
			"model": record.Name, "exit_code": record.ExitCode, "error": err.Error(),
		})
		return
	}

	m.mu.Lock()
	if current, exists := m.sessions[key]; exists && len(current.rootDispatchCompletions) > 0 && current.rootDispatchCompletions[0].DeliveryID == record.DeliveryID {
		current.rootDispatchCompletions = current.rootDispatchCompletions[1:]
		if err := persistRootDispatchOutbox(current.conversationID, current.rootDispatchCompletions); err != nil {
			current.rootDispatchCompletions = append([]rootDispatchCompletion{record}, current.rootDispatchCompletions...)
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelError, "session.dispatch_delivery", "root dispatch completion acknowledgement persistence failed", map[string]any{
				"session_id": key, "delivery_id": record.DeliveryID, "dispatch_id": record.DispatchID, "error": err.Error(),
			})
			return
		}
	}
	m.mu.Unlock()
	m.emitPromptInjected(key, record.Text, string(types.InjectionKindAgentCompletion))
	utils.LogWithFields(utils.LevelInfo, "session.dispatch_delivery", "root dispatch completion delivered", map[string]any{
		"session_id": key, "delivery_id": record.DeliveryID, "dispatch_id": record.DispatchID,
		"model": record.Name, "exit_code": record.ExitCode,
	})
	// Continue only after acknowledgement, preserving FIFO ordering.
	m.retryRootDispatchCompletions(key)
}

func rootDispatchStatus(exitCode int) string {
	switch exitCode {
	case 0:
		return "completed"
	case extcontextExitCodeRecalled:
		return "recalled"
	default:
		return "failed"
	}
}

func formatRootDispatchResult(result extension.DispatchAgentResult) string {
	status := rootDispatchStatus(result.ExitCode)
	return fmt.Sprintf("[Agent %s %s]\nDispatch ID: %s\nElapsed: %.1fs\n\n%s",
		result.Name, status, result.DispatchID, result.Elapsed, result.Output)
}

// extcontextExitCodeRecalled mirrors the stable dispatch terminal code without
// exposing an internal package dependency to session.
const extcontextExitCodeRecalled = 2
