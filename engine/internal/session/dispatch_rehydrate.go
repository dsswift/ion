package session

import (
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
//
// The loaded *conversation.Conversation is returned so the caller can reuse it
// (model seed, context-usage computation) without re-reading and re-parsing the
// conversation file. Returns nil when no conversation file exists yet (first run
// on this session ID). A non-nil conv is returned even when there are no
// dispatch entries — the file loaded fine, it just has nothing to rehydrate.
func (m *Manager) rehydrateDispatchState(s *engineSession, key string) *conversation.Conversation {
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		// No conversation file yet — first run on this session ID.
		// Nothing to rehydrate; this is the normal path for new sessions.
		utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: no conversation file for (expected for new sessions)", map[string]any{"key": key, "run_id": s.conversationID})
		return nil
	}

	dispatches := conversation.AgentDispatchEntries(conv)
	if len(dispatches) == 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: no dispatch entries", map[string]any{"key": key, "run_id": s.conversationID})
		return conv
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
			ids := make([]interface{}, len(d.ConversationIDs))
			for i, id := range d.ConversationIDs {
				ids[i] = id
			}
			metadata["conversationIds"] = ids
		}
		// Rehydrate the depth/parent attribution persisted in Commit 1 onto the
		// reloaded agent-state metadata, mirroring how conversationId/dispatches
		// are restored above. These carry the persisted value verbatim (0 / ""
		// for a top-level dispatch) so a reloaded row reports the same nesting
		// it had before the engine restart.
		metadata["dispatchDepth"] = d.DispatchDepth
		metadata["dispatchParentId"] = d.DispatchParentID

		// Build a dispatch info entry for the structured dispatches array.
		dispatchEntry := map[string]interface{}{
			"id":     d.AgentID,
			"task":   d.Task,
			"model":  d.Model,
			"status": d.Status,
		}
		if d.Elapsed > 0 {
			dispatchEntry["elapsed"] = d.Elapsed
		}
		if d.ConversationID != "" {
			dispatchEntry["conversationId"] = d.ConversationID
		}

		// Restore persisted dispatches array, or initialize with this entry.
		// The persisted array is de-duplicated by each entry's stable "id"
		// before it lands in the slot, so a legacy file whose array already
		// carries duplicate instances (the amplification bug) collapses to the
		// distinct set on load instead of re-seeding the duplication.
		if len(d.Dispatches) > 0 {
			metadata["dispatches"] = dedupDispatchesByID(nil, d.Dispatches)
		} else {
			metadata["dispatches"] = []interface{}{dispatchEntry}
		}

		s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
			Name:     d.AgentName,
			ID:       d.AgentID,
			Status:   d.Status,
			Metadata: metadata,
		}, func(existing *types.AgentStateUpdate) {
			existing.Name = d.AgentName
			existing.Status = d.Status
			if existing.Metadata == nil {
				existing.Metadata = map[string]interface{}{}
			}
			existing.Metadata["task"] = d.Task
			existing.Metadata["model"] = d.Model
			existing.Metadata["elapsed"] = d.Elapsed
			// Later entries may carry a corrected displayName (e.g. "Comms Director"
			// instead of the raw "comms-director" from an early buggy persist).
			if d.DisplayName != "" && d.DisplayName != d.AgentName {
				existing.Metadata["displayName"] = d.DisplayName
			}
			if d.ConversationID != "" {
				existing.Metadata["conversationId"] = d.ConversationID
			}

			// Merge conversationIds: union old + new, preserving order, no duplicates.
			existingIDs, _ := existing.Metadata["conversationIds"].([]interface{})
			seen := make(map[string]bool, len(existingIDs))
			for _, id := range existingIDs {
				if s, ok := id.(string); ok {
					seen[s] = true
				}
			}
			if d.ConversationID != "" && !seen[d.ConversationID] {
				existingIDs = append(existingIDs, d.ConversationID)
				seen[d.ConversationID] = true
			}
			for _, id := range d.ConversationIDs {
				if !seen[id] {
					existingIDs = append(existingIDs, id)
					seen[id] = true
				}
			}
			if len(existingIDs) > 0 {
				existing.Metadata["conversationIds"] = existingIDs
			}

			// Merge the structured dispatches array, unioning by each entry's
			// stable "id" so an instance is held once per slot regardless of how
			// many persisted entries reference it. When the persisted entry
			// carries a full dispatches array, union it with whatever the slot
			// already holds (it has startTime, elapsed, etc.). Otherwise fall
			// back to unioning the bare dispatchEntry.
			existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
			if len(d.Dispatches) > 0 {
				existing.Metadata["dispatches"] = dedupDispatchesByID(existingDispatches, d.Dispatches)
			} else {
				existing.Metadata["dispatches"] = dedupDispatchesByID(existingDispatches, []map[string]interface{}{dispatchEntry})
			}
		})
	}

	utils.LogWithFields(utils.LevelInfo, "session", "rehydratedispatchstate: loaded dispatch entries", map[string]any{"count": len(dispatches), "key": key, "run_id": s.conversationID})
	return conv
}

// dedupDispatchesByID unions an existing []interface{} dispatches slice with a
// freshly-loaded []map[string]interface{} slice, keying on each entry's stable
// "id" so an instance appears exactly once. First-seen order is preserved:
// existing entries keep their position, new ids are appended in load order.
// Entries with no usable "id" are always kept (they cannot be de-duplicated)
// so malformed members survive rather than being silently dropped. The result
// is a fresh []interface{} suitable for assignment into agent metadata.
func dedupDispatchesByID(existing []interface{}, loaded []map[string]interface{}) []interface{} {
	out := make([]interface{}, 0, len(existing)+len(loaded))
	seen := make(map[string]bool, len(existing)+len(loaded))

	for _, e := range existing {
		if m, ok := e.(map[string]interface{}); ok {
			if id, ok := m["id"].(string); ok && id != "" {
				if seen[id] {
					continue
				}
				seen[id] = true
			}
		}
		out = append(out, e)
	}

	for _, m := range loaded {
		if id, ok := m["id"].(string); ok && id != "" {
			if seen[id] {
				continue
			}
			seen[id] = true
		}
		out = append(out, m)
	}

	return out
}

// metaInt reads an integer-valued metadata key, tolerating both the int form
// (set in-process by the engine spawner) and the float64 form (produced by a
// JSON decode round-trip through the conversation file). Returns 0 when the
// key is absent or carries an unusable type.
func metaInt(meta map[string]interface{}, key string) int {
	switch v := meta[key].(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	}
	return 0
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

		// Dispatch depth and parent id follow the same read-from-meta pattern
		// as conversationId above. dispatchDepth arrives as int when set by
		// the engine spawner in-process, or as float64 after a JSON decode
		// round-trip (e.g. a prior persist -> rehydrate cycle), so normalize
		// both. dispatchParentId is always a string. Persisting these lets the
		// depth/parent attribution survive an engine restart.
		dispatchDepth := metaInt(meta, "dispatchDepth")
		dispatchParentID, _ := meta["dispatchParentId"].(string)

		// Build the structured dispatches array, de-duplicating by each
		// entry's stable "id". A grouped MergedSnapshot row can carry the same
		// instance more than once if an earlier persist -> rehydrate cycle
		// restored it into multiple slots; persisting that array verbatim would
		// bake the duplication into the conversation file and compound it on the
		// next load. Keying on "id" writes each instance exactly once. Entries
		// with no usable "id" are kept (append) so malformed members survive.
		var dispatchList []map[string]interface{}
		seenDispatchIDs := make(map[string]bool)
		if dl, ok := meta["dispatches"].([]interface{}); ok {
			for _, item := range dl {
				m, ok := item.(map[string]interface{})
				if !ok {
					continue
				}
				if id, ok := m["id"].(string); ok && id != "" {
					if seenDispatchIDs[id] {
						continue
					}
					seenDispatchIDs[id] = true
				}
				// Stamp depth/parent onto each surviving dispatch member so the
				// per-dispatch identity carries the attribution too, not just
				// the top-level record. Only set when non-zero/non-empty so we
				// never overwrite a member's own values with defaults.
				if dispatchDepth != 0 {
					m["dispatchDepth"] = dispatchDepth
				}
				if dispatchParentID != "" {
					m["dispatchParentId"] = dispatchParentID
				}
				dispatchList = append(dispatchList, m)
			}
		}

		// Derive conversationIDs from the structured dispatches array
		// (single source of truth). Keep childConvID from the legacy
		// field as the "latest" pointer for AgentDispatchData.ConversationID.
		var convIDs []string
		for _, dm := range dispatchList {
			if cid, ok := dm["conversationId"].(string); ok && cid != "" {
				convIDs = append(convIDs, cid)
			}
		}

		dispatches = append(dispatches, conversation.SessionEntry{
			ID:        state.ID,
			ParentID:  nil,
			Type:      conversation.EntryAgentDispatch,
			Timestamp: time.Now().UnixMilli(),
			Data: conversation.AgentDispatchData{
				AgentName:        state.Name,
				AgentID:          state.ID,
				DisplayName:      displayName,
				Task:             task,
				Model:            model,
				Status:           state.Status,
				Elapsed:          elapsed,
				ConversationID:   childConvID,
				ConversationIDs:  convIDs,
				Dispatches:       dispatchList,
				DispatchDepth:    dispatchDepth,
				DispatchParentID: dispatchParentID,
			},
		})
	}

	if len(dispatches) == 0 {
		return
	}

	conv, err := conversation.Load(convID, "")
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "persistterminaldispatches: load failed", map[string]any{"run_id": convID, "error": err})
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
		// Dispatch records are intentional extra roots (ParentID nil) that do
		// not move the leaf; append through the locked detached funnel rather
		// than mutating conv.Entries directly (see conversation/lock.go).
		conversation.AppendDetachedEntry(conv, d)
		added++
	}

	if added == 0 {
		return
	}

	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "persistterminaldispatches: save failed", map[string]any{"run_id": convID, "error": err})
		return
	}

	utils.LogWithFields(utils.LevelInfo, "session", "persistterminaldispatches: persisted dispatch entries", map[string]any{"added": added, "run_id": convID, "key": key})
}
