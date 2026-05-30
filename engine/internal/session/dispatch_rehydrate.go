package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// rehydrateDispatchState loads agent_dispatch entries from the
// conversation file and populates the session's agent registry so
// that completed dispatches survive engine restarts.
//
// Each persisted AgentDispatchData becomes an AgentStateUpdate in
// s.agents.states. On the next MergedSnapshot (triggered by
// ReconcileState or the extension's session_start roster emission),
// these entries merge with the extension roster — engine-managed
// entries win for deduplication, preserving task, conversationId,
// and elapsed metadata.
func (m *Manager) rehydrateDispatchState(s *engineSession, key string) {
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		// No conversation file yet — first run on this session ID.
		// Nothing to rehydrate; this is the normal path for new sessions.
		utils.Debug("Session", fmt.Sprintf("rehydrateDispatchState: no conversation file for key=%s id=%s (expected for new sessions)", key, s.conversationID))
		return
	}

	dispatches := conversation.AgentDispatchEntries(conv)
	if len(dispatches) == 0 {
		utils.Debug("Session", fmt.Sprintf("rehydrateDispatchState: no dispatch entries key=%s id=%s", key, s.conversationID))
		return
	}

	for _, d := range dispatches {
		metadata := map[string]interface{}{
			"displayName": d.DisplayName,
			"type":        "agent",
			"visibility":  "sticky",
			"invited":     true,
			"task":        d.Task,
			"model":       d.Model,
			"elapsed":     d.Elapsed,
		}
		if d.ConversationID != "" {
			metadata["conversationId"] = d.ConversationID
		}
		if len(d.ConversationIDs) > 0 {
			// Convert []string to []interface{} for consistency with the
			// in-memory format used by dispatch_agent.go and spawner.
			ids := make([]interface{}, len(d.ConversationIDs))
			for i, id := range d.ConversationIDs {
				ids[i] = id
			}
			metadata["conversationIds"] = ids
		}

		s.agents.AppendState(types.AgentStateUpdate{
			Name:     d.AgentName,
			ID:       d.AgentID,
			Status:   d.Status,
			Metadata: metadata,
		})
	}

	utils.Log("Session", fmt.Sprintf("rehydrateDispatchState: loaded %d dispatch entries key=%s id=%s", len(dispatches), key, s.conversationID))
}

// persistTerminalDispatches scans the session's agent registry for
// terminal dispatch states and persists them as agent_dispatch entries
// in the conversation file. Called from handleRunExit AFTER the
// backend's final conversation save, so the load-append-save cycle
// cannot be overwritten by a subsequent backend save.
func (m *Manager) persistTerminalDispatches(key, convID string) {
	if convID == "" {
		return
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}

	// Collect terminal states that look like dispatches (have task metadata).
	snapshot := s.agents.MergedSnapshot()
	var dispatches []conversation.SessionEntry
	for _, state := range snapshot {
		if state.Status != "done" && state.Status != "error" && state.Status != "cancelled" {
			continue
		}
		meta := state.Metadata
		if meta == nil {
			continue
		}
		// Only persist entries with dispatch metadata (task field).
		// Extension-only roster entries (idle, no task) are skipped.
		task, _ := meta["task"].(string)
		if task == "" {
			continue
		}

		displayName, _ := meta["displayName"].(string)
		model, _ := meta["model"].(string)
		elapsed, _ := meta["elapsed"].(float64)
		childConvID, _ := meta["conversationId"].(string)

		var convIDs []string
		if childConvID != "" {
			convIDs = []string{childConvID}
		}
		// Also try to extract accumulated conversationIds.
		if ids, ok := meta["conversationIds"].([]interface{}); ok {
			convIDs = make([]string, 0, len(ids))
			for _, id := range ids {
				if s, ok := id.(string); ok {
					convIDs = append(convIDs, s)
				}
			}
		}

		dispatches = append(dispatches, conversation.SessionEntry{
			ID:        state.ID,
			ParentID:  nil,
			Type:      conversation.EntryAgentDispatch,
			Timestamp: time.Now().UnixMilli(),
			Data: conversation.AgentDispatchData{
				AgentName:       state.Name,
				AgentID:         state.ID,
				DisplayName:     displayName,
				Task:            task,
				Model:           model,
				Status:          state.Status,
				Elapsed:         elapsed,
				ConversationID:  childConvID,
				ConversationIDs: convIDs,
			},
		})
	}

	if len(dispatches) == 0 {
		return
	}

	conv, err := conversation.Load(convID, "")
	if err != nil {
		utils.Log("Session", fmt.Sprintf("persistTerminalDispatches: load failed id=%s err=%v", convID, err))
		return
	}

	// Check for existing dispatch entries to avoid duplicates on re-runs.
	existing := make(map[string]bool)
	for _, e := range conv.Entries {
		if e.Type == conversation.EntryAgentDispatch {
			existing[e.ID] = true
		}
	}

	var added int
	for _, d := range dispatches {
		if existing[d.ID] {
			continue
		}
		conv.Entries = append(conv.Entries, d)
		added++
	}

	if added == 0 {
		return
	}

	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("Session", fmt.Sprintf("persistTerminalDispatches: save failed id=%s err=%v", convID, err))
		return
	}

	utils.Log("Session", fmt.Sprintf("persistTerminalDispatches: persisted %d dispatch entries convId=%s key=%s", added, convID, key))
}
