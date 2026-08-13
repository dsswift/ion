package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
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
		utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: no conversation file for (expected for new sessions)", map[string]any{"key": key, "conversation_id": s.conversationID})
		return nil
	}

	dispatches := conversation.AgentDispatchEntries(conv)
	if len(dispatches) == 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: no dispatch entries", map[string]any{"key": key, "conversation_id": s.conversationID})
		return conv
	}

	for _, d := range dispatches {
		// A persisted status of running/suspended is provably a LOST
		// dispatch: the registry is process memory and starts empty on boot,
		// so nothing that was in flight when the previous engine process
		// died survived into this one. Never rehydrate it as live — mark it
		// error so no panel shows a dead dispatch as running, and record the
		// loss so startSession can emit engine_dispatch_lost and fire the
		// dispatch_lost hook once the session's extensions are up. Because
		// entries supersede per AgentID (last-entry-wins below), a dispatch
		// whose lifecycle reached a terminal persist reads terminal here and
		// is NOT flagged — only genuinely-interrupted dispatches are.
		//
		// NOTE this check runs on each entry but the authoritative status is
		// the LAST entry per AgentID; resolve the loss set after the loop
		// from the merged registry state, not per-entry.
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
			"task":   dispatchTaskLabel(d.Task),
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
			metadata["dispatches"] = mergeDispatchesByID(nil, d.Dispatches)
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
			existingIDs, _ := existing.Metadata["conversationIds"].([]interface{}) //nolint:errcheck // best-effort; failure not actionable here
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
			existingDispatches, _ := existing.Metadata["dispatches"].([]interface{}) //nolint:errcheck // best-effort; failure not actionable here
			if len(d.Dispatches) > 0 {
				existing.Metadata["dispatches"] = mergeDispatchesByID(existingDispatches, d.Dispatches)
			} else {
				existing.Metadata["dispatches"] = mergeDispatchesByID(existingDispatches, []map[string]interface{}{dispatchEntry})
			}
		})
	}

	// Resolve losses AFTER the merge loop: the agent registry now holds the
	// last-entry-wins status per dispatch. Any dispatch whose RESOLVED status
	// is running/suspended did not survive the restart. Flip it to error in
	// place and queue the loss for startSession to announce (the typed
	// engine_dispatch_lost + the dispatch_lost hook fire once the session's
	// event stream and extensions are up — rehydrate runs before both).
	lostByID := map[string]conversation.AgentDispatchData{}
	for _, d := range dispatches {
		lostByID[d.AgentID] = d // last entry wins, matching the merge above
	}
	var lost []conversation.AgentDispatchData
	for id, d := range lostByID {
		if d.Status != "running" && d.Status != "suspended" {
			continue
		}
		s.agents.UpdateStateByID(id, func(st *types.AgentStateUpdate) {
			st.Status = "error"
			if st.Metadata == nil {
				st.Metadata = map[string]interface{}{}
			}
			st.Metadata["lastWork"] = "engine restarted while dispatch was running"
		})
		if d.LostNoticeState == "sent" || d.RecallIntent {
			utils.LogWithFields(utils.LevelInfo, "session", "rehydratedispatchstate: resolved lost dispatch (already acked/recalled)", map[string]any{"run_id": id, "lost_notice_state": d.LostNoticeState, "recall_intent": d.RecallIntent, "conversation_id": s.conversationID})
			continue
		}
		lost = append(lost, d)
		utils.LogWithFields(utils.LevelWarn, "session", "rehydratedispatchstate: dispatch lost (was running at engine death)", map[string]any{
			"key": key, "run_id": id, "model": d.AgentName, "reason": d.Status, "conversation_id": d.ConversationID,
		})
	}
	if len(lost) == 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: no lost dispatches", map[string]any{"key": key, "conversation_id": s.conversationID})
	}
	s.lostDispatches = lost

	utils.LogWithFields(utils.LevelInfo, "session", "rehydratedispatchstate: loaded dispatch entries", map[string]any{"count": len(dispatches), "key": key, "conversation_id": s.conversationID})
	return conv
}

// announceLostDispatches emits the typed engine_dispatch_lost event and fires
// the dispatch_lost hook for every dispatch rehydrateDispatchState resolved
// as lost, then clears the queue. Called from startSession AFTER extensions
// are loaded — the hook needs a live extension group, and the event needs
// the session's stream — while rehydration itself runs before either exists.
// One event + one hook firing per orphan; consumers own what happens next
// (redispatch, harvest the child conversation, notify the orchestrator).
func (m *Manager) announceLostDispatches(s *engineSession, key string) {
	lost := s.lostDispatches
	if len(lost) == 0 {
		return
	}
	s.lostDispatches = nil

	for _, d := range lost {
		m.persistLostNoticeState(s.conversationID, d.AgentID, "pending")
		utils.LogWithFields(utils.LevelInfo, "session", "announcing lost dispatch", map[string]any{
			"key": key, "run_id": d.AgentID, "model": d.AgentName, "conversation_id": d.ConversationID,
		})
		m.emit(key, types.EngineEvent{
			Type: "engine_dispatch_lost",
			DispatchLost: &types.DispatchLostPayload{
				DispatchID:          d.AgentID,
				AgentName:           d.AgentName,
				Task:                d.Task,
				ParentDispatchID:    d.DispatchParentID,
				Depth:               d.DispatchDepth,
				ChildConversationID: d.ConversationID,
			},
		})
		if s.extGroup != nil && !s.extGroup.IsEmpty() {
			hookCtx := m.newExtContext(s, key)
			s.extGroup.FireDispatchLost(hookCtx, extension.DispatchLostInfo{
				DispatchID:          d.AgentID,
				AgentName:           d.AgentName,
				Task:                d.Task,
				ParentDispatchID:    d.DispatchParentID,
				Depth:               d.DispatchDepth,
				ChildConversationID: d.ConversationID,
			})
		}
	}
	// The error transitions from rehydration are now part of the registry;
	// push one snapshot so consumers see the corrected states immediately.
	// force=true: these are terminal (error) transitions recovered after a
	// restart, so they carry the same never-delay obligation as a live abort.
	m.emitAgentSnapshot(key, agentSnapshotReasonRehydrate, true, s.agents.MergedSnapshot())
}

// mergeDispatchesByID overlays later persisted members onto earlier members
// with the same stable id. First-seen order stays stable, but field values use
// last-write-wins semantics, matching the parent AgentStateUpdate lifecycle:
// registration records say running, terminal records later add done/error,
// conversationId, and elapsed. Rehydration must never restore the stale
// registration member just because it appeared first in the conversation file.
//
// Members without a usable id remain append-only. They cannot be correlated
// safely, so attempting to merge them would invent identity and hide malformed
// source data.
func mergeDispatchesByID(existing []interface{}, loaded []map[string]interface{}) []interface{} {
	out := make([]interface{}, 0, len(existing)+len(loaded))
	indices := make(map[string]int, len(existing)+len(loaded))

	appendOrOverlay := func(member map[string]interface{}) {
		id, ok := member["id"].(string)
		if !ok || id == "" {
			out = append(out, cloneDispatchMember(member))
			return
		}
		if index, seen := indices[id]; seen {
			prior, ok := out[index].(map[string]interface{})
			if !ok {
				// Preserve malformed existing data and append the addressable
				// later member rather than replacing an unknown shape.
				indices[id] = len(out)
				out = append(out, cloneDispatchMember(member))
				return
			}
			statusBefore, _ := prior["status"].(string)       //nolint:errcheck // diagnostic only
			convBefore, _ := prior["conversationId"].(string) //nolint:errcheck // diagnostic only
			merged := cloneDispatchMember(prior)
			for key, value := range member {
				merged[key] = value
			}
			out[index] = merged
			statusAfter, _ := merged["status"].(string)       //nolint:errcheck // diagnostic only
			convAfter, _ := merged["conversationId"].(string) //nolint:errcheck // diagnostic only
			utils.LogWithFields(utils.LevelDebug, "session", "rehydratedispatchstate: later dispatch member superseded earlier member", map[string]any{
				"dispatch_id":             id,
				"status_changed":          statusBefore != statusAfter,
				"conversation_id_changed": convBefore != convAfter,
			})
			return
		}
		indices[id] = len(out)
		out = append(out, cloneDispatchMember(member))
	}

	for _, entry := range existing {
		if member, ok := entry.(map[string]interface{}); ok {
			appendOrOverlay(member)
			continue
		}
		out = append(out, entry)
	}
	for _, member := range loaded {
		appendOrOverlay(member)
	}
	return out
}

func cloneDispatchMember(member map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(member))
	for key, value := range member {
		out[key] = value
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
		// Dispatch identity is authoritative. `task` is descriptive metadata and
		// must not decide whether a terminal dispatch is persisted.
		_, hasDispatches := meta["dispatches"].([]interface{}) //nolint:errcheck // best-effort; malformed metadata is not a dispatch
		task, _ := meta["task"].(string)                       //nolint:errcheck // best-effort; optional display data
		if state.ID == "" || (!hasDispatches && task == "") {
			continue
		}

		displayName, _ := meta["displayName"].(string)    //nolint:errcheck // best-effort; failure not actionable here
		model, _ := meta["model"].(string)                //nolint:errcheck // best-effort; failure not actionable here
		elapsed, _ := meta["elapsed"].(float64)           //nolint:errcheck // best-effort; failure not actionable here
		childConvID, _ := meta["conversationId"].(string) //nolint:errcheck // best-effort; failure not actionable here

		// Dispatch depth and parent id follow the same read-from-meta pattern
		// as conversationId above. dispatchDepth arrives as int when set by
		// the engine spawner in-process, or as float64 after a JSON decode
		// round-trip (e.g. a prior persist -> rehydrate cycle), so normalize
		// both. dispatchParentId is always a string. Persisting these lets the
		// depth/parent attribution survive an engine restart.
		dispatchDepth := metaInt(meta, "dispatchDepth")
		dispatchParentID, _ := meta["dispatchParentId"].(string) //nolint:errcheck // best-effort; failure not actionable here

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

	// Same serialization rationale as persistDispatchRegistered: this is a
	// read-modify-write of the conversation file, and terminal transitions of
	// a fan-out land concurrently.
	var added int
	err := conversation.UpdateOnDisk(convID, "", func(conv *conversation.Conversation) (bool, error) {
		added = 0

		// Dedup is (dispatch, status)-aware, not ID-only. The dispatch lifecycle
		// is persisted as SUPERSEDING entries: registration writes a `running`
		// record (persistDispatchRegistered) and the terminal transition must
		// still land afterwards — an ID-only dedup would skip it forever, the
		// file would read `running` for a cleanly-completed dispatch, and the
		// NEXT restart's rehydrate would mark it lost and emit a false
		// engine_dispatch_lost. Rehydrate resolves last-entry-wins per dispatch,
		// so a register(running) → complete(done) file reads as done. Keyed on
		// the DATA's AgentID (the stable dispatch identity) with the LAST
		// persisted status winning, so a same-status re-persist is skipped on
		// every subsequent run exit (handleRunExit runs per exit; a terminal
		// state does not change again).
		lastStatus := make(map[string]string) // dispatch AgentID -> last persisted status
		for _, e := range conv.Entries {
			if e.Type == conversation.EntryAgentDispatch {
				if ad := conversation.AsAgentDispatchData(e.Data); ad != nil {
					lastStatus[ad.AgentID] = ad.Status
				}
			}
		}

		for _, d := range dispatches {
			ad := conversation.AsAgentDispatchData(d.Data)
			if ad == nil {
				continue
			}
			prev, seen := lastStatus[ad.AgentID]
			if seen && prev == ad.Status {
				continue
			}
			// Dispatch records are intentional extra roots (ParentID nil) that do
			// not move the leaf; append through the locked detached funnel rather
			// than mutating conv.Entries directly (see conversation/lock.go).
			// A status change appends a NEW entry for the same dispatch; the
			// SessionEntry ID must stay unique per line, so superseding entries
			// carry a suffix while the data's AgentID keeps the stable identity.
			if seen {
				d.ID = fmt.Sprintf("%s-s%d", d.ID, time.Now().UnixMilli())
			}
			conversation.AppendDetachedEntry(conv, d)
			lastStatus[ad.AgentID] = ad.Status
			added++
		}

		return added > 0, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "persistterminaldispatches: persist failed", map[string]any{"conversation_id": convID, "error": utils.ErrStr(err)})
		return
	}
	if added == 0 {
		utils.LogWithFields(utils.LevelDebug, "session", "persistterminaldispatches: nothing to add (no-op)", map[string]any{"conversation_id": convID, "key": key})
		return
	}

	utils.LogWithFields(utils.LevelInfo, "session", "persistterminaldispatches: persisted dispatch entries", map[string]any{"added": added, "conversation_id": convID, "key": key})
}

// persistDispatchRegistered writes a `running` agent_dispatch record for a
// freshly-registered dispatch into the parent conversation file — the
// durability half of dispatch-loss detection. The dispatch registry is
// process memory: when the engine dies, every in-flight dispatch dies with
// it and no terminal callback ever fires. Without an on-disk `running`
// record there is nothing for the next start's rehydration to notice, and
// the loss is invisible (the orchestrator polls an empty registry and
// guesses — the goat-conversation incident). With it, rehydration resolves
// the dispatch's last persisted status: still `running`/`suspended` means
// provably dead, and the loss is surfaced (agent state → error, typed
// engine_dispatch_lost, dispatch_lost hook).
//
// persistTerminalDispatches later appends a superseding terminal entry for
// the same dispatch (its dedup is status-aware), so a dispatch that
// completes normally never reads as lost.
//
// Best-effort: every failure branch logs and returns; a dispatch must not
// fail because its durability record could not be written.
func (m *Manager) persistDispatchRegistered(key, convID, agentID, agentName, displayName, task, model, parentDispatchID string, depth int) {
	if convID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "persistdispatchregistered: no conversation id (no-op)", map[string]any{"key": key, "run_id": agentID})
		return
	}
	// The load/append/save runs inside UpdateOnDisk so a dispatch fan-out
	// cannot lose records: without it, four concurrent registrations each
	// load the same pre-fan-out file and the last save overwrites the other
	// three, leaving the dispatch-loss detector blind exactly when the most
	// dispatches are in flight.
	err := conversation.UpdateOnDisk(convID, "", func(conv *conversation.Conversation) (bool, error) {
		// Skip when this dispatch already has a persisted record (an engine-side
		// retry or a re-entrant registration); the lifecycle owns supersession.
		for _, e := range conv.Entries {
			if e.Type != conversation.EntryAgentDispatch {
				continue
			}
			if ad := conversation.AsAgentDispatchData(e.Data); ad != nil && ad.AgentID == agentID {
				utils.LogWithFields(utils.LevelDebug, "session", "persistdispatchregistered: record already present (no-op)", map[string]any{"run_id": agentID, "reason": ad.Status})
				return false, nil
			}
		}
		conversation.AppendDetachedEntry(conv, conversation.SessionEntry{
			ID:        agentID,
			ParentID:  nil,
			Type:      conversation.EntryAgentDispatch,
			Timestamp: time.Now().UnixMilli(),
			Data: conversation.AgentDispatchData{
				AgentName:        agentName,
				AgentID:          agentID,
				DisplayName:      displayName,
				Task:             task,
				Model:            model,
				Status:           "running",
				DispatchDepth:    depth,
				DispatchParentID: parentDispatchID,
			},
		})
		return true, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "persistdispatchregistered: persist failed", map[string]any{"conversation_id": convID, "run_id": agentID, "error": utils.ErrStr(err)})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "persistdispatchregistered: running record persisted", map[string]any{"run_id": agentID, "model": agentName, "key": key, "conversation_id": convID})
}

// persistLostNoticeState durably updates the latest record for an orphan before
// it is emitted. Pending is intentionally retried after a crash until the host
// receives the consumer's explicit acknowledgement.
func (m *Manager) persistLostNoticeState(conversationID, agentID, state string) {
	m.updatePersistedDispatch(conversationID, agentID, func(d *conversation.AgentDispatchData) {
		// "sent" is terminal. A delayed announcement must never downgrade an
		// acknowledgement back to pending and cause another restart delivery.
		if d.LostNoticeState == "sent" && state == "pending" {
			return
		}
		d.LostNoticeState = state
	})
}

// persistRecallIntent marks a dispatch as intentionally recalled. It is kept
// separate from lifecycle status because a process death can occur before a
// terminal callback writes its superseding entry.
func (m *Manager) persistRecallIntent(conversationID, agentID string) {
	m.updatePersistedDispatch(conversationID, agentID, func(d *conversation.AgentDispatchData) {
		d.RecallIntent = true
	})
}

func (m *Manager) updatePersistedDispatch(conversationID, agentID string, update func(*conversation.AgentDispatchData)) {
	if conversationID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "updatepersisteddispatch: no conversation id", map[string]any{"run_id": agentID})
		return
	}
	// UpdateOnDisk serializes this read-modify-write against every other
	// dispatch persister (persistDispatchRegistered, persistTerminalDispatches)
	// on the same conversation, so a state update cannot overwrite a concurrent
	// append and vice versa.
	updated := false
	err := conversation.UpdateOnDisk(conversationID, "", func(conv *conversation.Conversation) (bool, error) {
		for i := range conv.Entries {
			e := &conv.Entries[i]
			if e.Type != conversation.EntryAgentDispatch {
				continue
			}
			d := conversation.AsAgentDispatchData(e.Data)
			if d == nil || d.AgentID != agentID {
				continue
			}
			update(d)
			e.Data = *d
			updated = true
		}
		if !updated {
			utils.LogWithFields(utils.LevelDebug, "session", "updatepersisteddispatch: dispatch record not found", map[string]any{"conversation_id": conversationID, "run_id": agentID})
		}
		return updated, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "updatepersisteddispatch: persist failed", map[string]any{"conversation_id": conversationID, "run_id": agentID, "error": utils.ErrStr(err)})
		return
	}
	if !updated {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "updatepersisteddispatch: persisted dispatch state", map[string]any{"conversation_id": conversationID, "run_id": agentID})
}

// persistRecallIntents propagates a recall across every conversation file owned
// by the registry cascade. Registry entries are removed after this callback, so
// this is the only point where target and descendant session identities coexist.
func (m *Manager) persistRecallIntents(recalled []extcontext.RecalledDispatch) {
	visited := make(map[string]bool, len(recalled))
	for _, dispatch := range recalled {
		if dispatch.DispatchID == "" || visited[dispatch.DispatchID] {
			continue
		}
		visited[dispatch.DispatchID] = true
		m.mu.RLock()
		session := m.sessions[dispatch.SessionID]
		m.mu.RUnlock()
		if session == nil {
			utils.LogWithFields(utils.LevelWarn, "session", "persistrecallintents: session not found", map[string]any{"run_id": dispatch.DispatchID, "session_id": dispatch.SessionID, "model": dispatch.Name})
			continue
		}
		m.persistRecallIntent(session.conversationID, dispatch.DispatchID)
	}
}
