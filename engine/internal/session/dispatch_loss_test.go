package session

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for dispatch-loss detection (dispatch-lifecycle root cause G): a
// dispatch persisted as running/suspended with a fresh (empty) registry died
// with the previous engine process. Rehydration must mark it error, emit one
// engine_dispatch_lost per orphan, and never invent a loss for a dispatch
// whose lifecycle reached a terminal persist (the status-aware supersession
// contract).

// lossTestEnv builds a manager + session against a temp conversation store.
func lossTestEnv(t *testing.T, convID string, entries []conversation.SessionEntry) (*Manager, *engineSession, func() []types.EngineEvent) {
	t.Helper()
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)
	if err := os.MkdirAll(filepath.Join(dataDir, "conversations"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	conv := conversation.CreateConversation(convID, "sys", "test-model")
	conversation.AddUserMessage(conv, "hello")
	for _, e := range entries {
		conversation.AppendDetachedEntry(conv, e)
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var mu sync.Mutex
	var emitted []types.EngineEvent
	m := &Manager{
		sessions: make(map[string]*engineSession),
		onEvent: func(_ string, ev types.EngineEvent) {
			mu.Lock()
			emitted = append(emitted, ev)
			mu.Unlock()
		},
	}
	s := &engineSession{
		key:              "loss-test-key",
		conversationID:   convID,
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	m.sessions[s.key] = s

	events := func() []types.EngineEvent {
		mu.Lock()
		defer mu.Unlock()
		out := make([]types.EngineEvent, len(emitted))
		copy(out, emitted)
		return out
	}
	return m, s, events
}

func dispatchEntry(agentID, agent, status, childConvID string) conversation.SessionEntry {
	return conversation.SessionEntry{
		ID: agentID, ParentID: nil,
		Type: conversation.EntryAgentDispatch, Timestamp: time.Now().UnixMilli(),
		Data: conversation.AgentDispatchData{
			AgentName:      agent,
			AgentID:        agentID,
			Task:           "some task",
			Status:         status,
			ConversationID: childConvID,
		},
	}
}

// TestDispatchLoss_RunningAtCrashIsMarkedLost pins the loss path: a persisted
// `running` dispatch rehydrates as error, and announceLostDispatches emits
// exactly one engine_dispatch_lost carrying the child conversation ID.
//
// Revert bar: without the loss detection, the rehydrated state stays
// "running" (a dead dispatch renders live forever) and no event fires.
func TestDispatchLoss_RunningAtCrashIsMarkedLost(t *testing.T) {
	m, s, events := lossTestEnv(t, "loss-conv-1", []conversation.SessionEntry{
		dispatchEntry("dispatch-dev-lead-999", "dev-lead", "running", "conv-child-1"),
	})

	m.rehydrateDispatchState(s, s.key)

	// Agent state resolved to error, never left as running.
	snap := s.agents.MergedSnapshot()
	var found *types.AgentStateUpdate
	for i := range snap {
		if snap[i].ID == "dispatch-dev-lead-999" {
			found = &snap[i]
		}
	}
	if found == nil {
		t.Fatal("rehydrated dispatch missing from registry")
	}
	if found.Status != "error" {
		t.Fatalf("status = %q, want error (a dead dispatch must not render as running)", found.Status)
	}
	if lw, _ := found.Metadata["lastWork"].(string); lw != "engine restarted while dispatch was running" {
		t.Errorf("lastWork = %q, want the restart marker", lw)
	}

	// The announce pass emits exactly one typed loss event.
	m.announceLostDispatches(s, s.key)
	var losses []*types.DispatchLostPayload
	for _, ev := range events() {
		if ev.Type == "engine_dispatch_lost" {
			losses = append(losses, ev.DispatchLost)
		}
	}
	if len(losses) != 1 {
		t.Fatalf("engine_dispatch_lost count = %d, want 1", len(losses))
	}
	if losses[0].DispatchID != "dispatch-dev-lead-999" || losses[0].AgentName != "dev-lead" {
		t.Errorf("loss payload = %+v, want the orphan's identity", losses[0])
	}
	if losses[0].ChildConversationID != "conv-child-1" {
		t.Errorf("ChildConversationID = %q, want conv-child-1 (the harvest handle)", losses[0].ChildConversationID)
	}

	// The queue drains: a second announce emits nothing.
	m.announceLostDispatches(s, s.key)
	count := 0
	for _, ev := range events() {
		if ev.Type == "engine_dispatch_lost" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("engine_dispatch_lost fired %d times across two announces, want 1", count)
	}
}

// TestDispatchLoss_NoFalseLossForCompletedDispatch is the blocker regression
// bar from the plan: register(running) → terminal persist(done) → rehydrate
// resolves to done, emits ZERO loss events. This is the test that fails on an
// ID-dedup-skip persistence design (the terminal persist would be skipped and
// the file would forever read running) and passes on the status-aware
// supersession.
func TestDispatchLoss_NoFalseLossForCompletedDispatch(t *testing.T) {
	m, s, events := lossTestEnv(t, "loss-conv-2", []conversation.SessionEntry{
		dispatchEntry("dispatch-worker-1", "worker", "running", ""),
	})

	// Terminal persist: the dispatch completed. Simulate the real flow — a
	// terminal agent state persisted by persistTerminalDispatches, whose
	// status-aware dedup must supersede the running record despite the same
	// dispatch identity already having an entry.
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
		Name: "worker", ID: "dispatch-worker-1", Status: "done",
		Metadata: map[string]interface{}{
			"task":  "some task",
			"model": "test-model",
		},
	}, nil)
	m.persistTerminalDispatches(s.key, s.conversationID)

	// Fresh registry state, as a restart produces.
	s.agents = agents.NewRegistry()
	m.rehydrateDispatchState(s, s.key)

	snap := s.agents.MergedSnapshot()
	var status string
	for _, st := range snap {
		if st.ID == "dispatch-worker-1" {
			status = st.Status
		}
	}
	if status != "done" {
		t.Fatalf("resolved status = %q, want done (last-entry-wins supersession)", status)
	}

	m.announceLostDispatches(s, s.key)
	for _, ev := range events() {
		if ev.Type == "engine_dispatch_lost" {
			t.Fatalf("false loss: engine_dispatch_lost fired for a cleanly-completed dispatch (%+v)", ev.DispatchLost)
		}
	}
}

// TestDispatchLoss_RegistrationPersistsRunningRecord pins the durability
// half: persistDispatchRegistered writes a `running` agent_dispatch record
// before any run exit, and a duplicate registration is a no-op.
func TestDispatchLoss_RegistrationPersistsRunningRecord(t *testing.T) {
	m, s, _ := lossTestEnv(t, "loss-conv-3", nil)

	m.persistDispatchRegistered(s.key, s.conversationID, "dispatch-fresh-1", "lead", "Lead", "do work", "test-model", "", 1)
	m.persistDispatchRegistered(s.key, s.conversationID, "dispatch-fresh-1", "lead", "Lead", "do work", "test-model", "", 1) // dup: no-op

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var records []conversation.AgentDispatchData
	for _, e := range conv.Entries {
		if e.Type == conversation.EntryAgentDispatch {
			if ad := conversation.AsAgentDispatchData(e.Data); ad != nil && ad.AgentID == "dispatch-fresh-1" {
				records = append(records, *ad)
			}
		}
	}
	if len(records) != 1 {
		t.Fatalf("persisted records = %d, want exactly 1 (duplicate registration must be a no-op)", len(records))
	}
	if records[0].Status != "running" {
		t.Errorf("persisted status = %q, want running", records[0].Status)
	}
	if records[0].Task != "do work" || records[0].AgentName != "lead" {
		t.Errorf("persisted record = %+v, want the registration's identity", records[0])
	}
}
