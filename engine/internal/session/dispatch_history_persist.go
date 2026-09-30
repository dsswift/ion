package session

import (
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Durable dispatch history. The dispatch registry is process memory; this file
// is what carries its terminal history across a session or engine restart.
// Every terminal entry the registry records is written onto the dispatch's
// agent_dispatch records in the session's conversation file, and a starting
// session rebuilds the registry history from those records.

// lostDispatchReason is the terminal reason recorded for a dispatch that was
// in flight when the engine process died.
const lostDispatchReason = "engine restarted while dispatch was running"

// wireDispatchRegistryObservers connects the session's dispatch registry to
// durable persistence and to telemetry. Called once at session start.
func (m *Manager) wireDispatchRegistryObservers(s *engineSession, key string) {
	s.dispatchRegistry.SetTerminalObserver(func(entries []extcontext.DispatchTerminalEntry) {
		for _, e := range entries {
			m.persistDispatchTerminalRecord(s.conversationID, e)
		}
	})
	s.dispatchRegistry.SetControlMismatchObserver(func(mm extcontext.ControlMismatch) {
		m.emitDispatchControlMismatch(s, key, mm)
	})
}

// persistDispatchTerminalRecord writes how a dispatch ended onto its persisted
// records. Best-effort: a dispatch never fails over a durability record, and
// updatePersistedDispatch logs its own failures.
func (m *Manager) persistDispatchTerminalRecord(conversationID string, e extcontext.DispatchTerminalEntry) {
	record := &conversation.DispatchTerminalRecord{
		Status:      e.Status,
		Reason:      e.Reason,
		ExitCode:    e.ExitCode,
		CompletedAt: e.CompletedAt.UnixMilli(),
		ToolCount:   e.ToolCount,
	}
	if !e.StartedAt.IsZero() {
		record.StartedAt = e.StartedAt.UnixMilli()
	}
	m.updatePersistedDispatch(conversationID, e.DispatchID, func(d *conversation.AgentDispatchData) {
		d.Terminal = record
	})
}

// emitDispatchControlMismatch routes a registry mismatch report to the
// session's telemetry collector. Nil-safe on the collector; the registry has
// already logged the mismatch at WARN.
func (m *Manager) emitDispatchControlMismatch(s *engineSession, key string, mm extcontext.ControlMismatch) {
	if s.telemetry == nil {
		utils.LogWithFields(utils.LevelDebug, "session", "dispatch.control_mismatch not emitted: telemetry disabled", map[string]any{"dispatch_id": mm.DispatchID})
		return
	}
	s.telemetry.Event(telemetry.DispatchControlMismatch, map[string]any{
		"dispatch_id":          mm.DispatchID,
		"operation":            mm.Operation,
		"outcome":              mm.Outcome,
		"resolving_registry":   mm.ResolvingRegistry,
		"resolving_generation": mm.ResolvingGeneration,
		"holding_registry":     mm.HoldingRegistry,
		"holding_generation":   mm.HoldingGeneration,
		"holding_session_id":   mm.HoldingSessionID,
		"lifecycle_state":      mm.LifecycleState,
	}, correlationCtx(key, s.conversationID))
	utils.LogWithFields(utils.LevelDebug, "session", "dispatch.control_mismatch telemetry emitted", map[string]any{"dispatch_id": mm.DispatchID, "operation": mm.Operation})
}

// dispatchHistoryFromConversation rebuilds the registry's terminal history
// from a conversation's agent_dispatch records. Records supersede per dispatch
// (last entry wins for status and lineage), and the newest Terminal record
// carries the real reason and exit code. A dispatch whose final status is
// still in flight died with the previous engine process: it becomes "lost",
// unless a Terminal record shows the registry retired it (a recall that the
// process did not live to finish persisting). Records from before Terminal
// was kept fall back to their entry timestamps and leave the exit code unset.
func dispatchHistoryFromConversation(conv *conversation.Conversation, now time.Time) []extcontext.DispatchTerminalEntry {
	if conv == nil {
		return nil
	}
	type folded struct {
		last      conversation.AgentDispatchData
		terminal  *conversation.DispatchTerminalRecord
		firstSeen int64
		lastSeen  int64
	}
	byID := map[string]*folded{}
	var order []string
	for _, entry := range conv.Entries {
		if entry.Type != conversation.EntryAgentDispatch {
			continue
		}
		d := conversation.AsAgentDispatchData(entry.Data)
		if d == nil || d.AgentID == "" {
			continue
		}
		f, seen := byID[d.AgentID]
		if !seen {
			f = &folded{firstSeen: entry.Timestamp}
			byID[d.AgentID] = f
			order = append(order, d.AgentID)
		}
		f.last = *d
		f.lastSeen = entry.Timestamp
		if d.Terminal != nil {
			f.terminal = d.Terminal
		}
	}

	out := make([]extcontext.DispatchTerminalEntry, 0, len(order))
	for _, id := range order {
		f := byID[id]
		e := extcontext.DispatchTerminalEntry{
			DispatchID:          id,
			Name:                f.last.AgentName,
			ParentDispatchID:    f.last.DispatchParentID,
			Depth:               f.last.DispatchDepth,
			ChildConversationID: f.last.ConversationID,
			StartedAt:           time.UnixMilli(f.firstSeen),
		}
		switch {
		case f.terminal != nil:
			e.Status = f.terminal.Status
			e.Reason = f.terminal.Reason
			e.ExitCode = f.terminal.ExitCode
			e.ToolCount = f.terminal.ToolCount
			e.CompletedAt = time.UnixMilli(f.terminal.CompletedAt)
			if f.terminal.StartedAt != 0 {
				e.StartedAt = time.UnixMilli(f.terminal.StartedAt)
			}
		case f.last.Status == extcontext.DispatchStatusDone || f.last.Status == extcontext.DispatchStatusError || f.last.Status == extcontext.DispatchStatusCancelled:
			e.Status = f.last.Status
			e.CompletedAt = time.UnixMilli(f.lastSeen)
		case f.last.RecallIntent:
			e.Status = extcontext.DispatchStatusCancelled
			e.CompletedAt = time.UnixMilli(f.lastSeen)
		default:
			e.Status = extcontext.DispatchStatusLost
			e.Reason = lostDispatchReason
			e.CompletedAt = now
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CompletedAt.Before(out[j].CompletedAt) })
	return out
}
