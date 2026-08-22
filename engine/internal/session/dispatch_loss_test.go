package session

import (
	"fmt"
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
	for _, st := range snap {
		if st.ID != "dispatch-worker-1" {
			continue
		}
		dispatches, ok := st.Metadata["dispatches"].([]interface{})
		if !ok || len(dispatches) != 1 {
			t.Fatalf("rehydrated dispatches = %#v, want one terminal member", st.Metadata["dispatches"])
		}
		member := dispatches[0].(map[string]interface{})
		if member["status"] != "done" {
			t.Errorf("nested dispatch status = %#v, want done", member["status"])
		}
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

// TestDispatchLoss_DurableOutboxSurvivesRestart pins pending-before-emit and
// sent-after-ack semantics across fresh sessions reading the persisted file.
// TestDispatchLoss_EmptyChildConversationIDReachesConsumer preserves the empty
// payload so the consumer can choose branch-verification wording. Operator copy
// belongs to the ion-dev consumer, not the engine event transport.
func TestDispatchLoss_EmptyChildConversationIDReachesConsumer(t *testing.T) {
	m, s, events := lossTestEnv(t, "loss-empty-child", []conversation.SessionEntry{
		dispatchEntry("dispatch-empty-child", "worker", "running", ""),
	})
	m.rehydrateDispatchState(s, s.key)
	m.announceLostDispatches(s, s.key)
	for _, event := range events() {
		if event.Type == "engine_dispatch_lost" {
			if event.DispatchLost.ChildConversationID != "" {
				t.Fatalf("ChildConversationID = %q, want empty payload preserved", event.DispatchLost.ChildConversationID)
			}
			return
		}
	}
	t.Fatal("missing engine_dispatch_lost event")
}

func TestDispatchLoss_DurableOutboxSurvivesRestart(t *testing.T) {
	m1, s1, events1 := lossTestEnv(t, "loss-outbox", []conversation.SessionEntry{
		dispatchEntry("dispatch-outbox", "worker", "running", ""),
	})
	m1.rehydrateDispatchState(s1, s1.key)
	m1.announceLostDispatches(s1, s1.key)
	if got := countLossEvents(events1()); got != 1 {
		t.Fatalf("first restart losses = %d, want 1", got)
	}

	// This is the explicit host-RPC acknowledgement persistence endpoint.
	m1.persistLostNoticeState(s1.conversationID, "dispatch-outbox", "sent")
	m2, s2, events2 := freshLossSession(t, "loss-outbox")
	m2.rehydrateDispatchState(s2, s2.key)
	m2.announceLostDispatches(s2, s2.key)
	if got := countLossEvents(events2()); got != 0 {
		t.Fatalf("restart after acknowledgement losses = %d, want 0", got)
	}
	m3, s3, events3 := freshLossSession(t, "loss-outbox")
	m3.rehydrateDispatchState(s3, s3.key)
	m3.announceLostDispatches(s3, s3.key)
	if got := countLossEvents(events3()); got != 0 {
		t.Fatalf("second restart after acknowledgement losses = %d, want 0", got)
	}
}

// TestDispatchLoss_PendingRetriesAfterCrash proves pending remains retryable
// both before any emission and after emission without acknowledgement.
func TestDispatchLoss_PendingRetriesAfterCrash(t *testing.T) {
	m1, s1, _ := lossTestEnv(t, "loss-pending", []conversation.SessionEntry{
		dispatchEntry("dispatch-pending", "worker", "running", ""),
	})
	// Simulate death after durable pending write and before event emission.
	m1.persistLostNoticeState(s1.conversationID, "dispatch-pending", "pending")
	m2, s2, events2 := freshLossSession(t, "loss-pending")
	m2.rehydrateDispatchState(s2, s2.key)
	m2.announceLostDispatches(s2, s2.key)
	if got := countLossEvents(events2()); got != 1 {
		t.Fatalf("pending retry after pre-emit crash = %d, want 1", got)
	}
	// No acknowledgement: a second fresh engine must re-emit at least once.
	m3, s3, events3 := freshLossSession(t, "loss-pending")
	m3.rehydrateDispatchState(s3, s3.key)
	m3.announceLostDispatches(s3, s3.key)
	if got := countLossEvents(events3()); got != 1 {
		t.Fatalf("pending retry after post-emit crash = %d, want 1", got)
	}
}

// TestDispatchLoss_RecallIntentCrossFile suppresses loss delivery for a child
// registered by another session after its parent recall cascades through the registry.
func TestDispatchLoss_RecallIntentCrossFile(t *testing.T) {
	m, parent, _ := lossTestEnv(t, "parent-conversation", []conversation.SessionEntry{
		dispatchEntry("parent-dispatch", "parent", "running", ""),
	})
	childID := "child-conversation"
	child := conversation.CreateConversation(childID, "sys", "model")
	conversation.AppendDetachedEntry(child, dispatchEntry("child-dispatch", "child", "running", ""))
	if err := conversation.Save(child, ""); err != nil {
		t.Fatal(err)
	}
	childSession := &engineSession{key: "child-key", conversationID: childID, agents: agents.NewRegistry(), dispatchRegistry: parent.dispatchRegistry, pending: pending.New()}
	m.sessions[childSession.key] = childSession
	parent.dispatchRegistry.RegisterWithID("parent-dispatch", "parent", func() {}, nil, parent.key, "", 1)
	parent.dispatchRegistry.RegisterWithID("child-dispatch", "child", func() {}, nil, childSession.key, "parent-dispatch", 2)
	parent.dispatchRegistry.SetRecallObserver(m.persistRecallIntents)
	if !parent.dispatchRegistry.RecallByID("parent-dispatch", "test recall") {
		t.Fatal("Recall = false, want true")
	}
	loaded, err := conversation.Load(childID, "")
	if err != nil {
		t.Fatal(err)
	}
	entries := conversation.AgentDispatchEntries(loaded)
	if len(entries) != 1 || !entries[0].RecallIntent {
		t.Fatalf("child recall intent = %#v, want true", entries)
	}
	m2, s2, events := freshLossSession(t, childID)
	m2.rehydrateDispatchState(s2, s2.key)
	m2.announceLostDispatches(s2, s2.key)
	if got := countLossEvents(events()); got != 0 {
		t.Fatalf("recalled child losses = %d, want 0", got)
	}
}

func freshLossSession(t *testing.T, convID string) (*Manager, *engineSession, func() []types.EngineEvent) {
	t.Helper()
	var mu sync.Mutex
	var emitted []types.EngineEvent
	m := &Manager{sessions: make(map[string]*engineSession), onEvent: func(_ string, ev types.EngineEvent) { mu.Lock(); defer mu.Unlock(); emitted = append(emitted, ev) }}
	s := &engineSession{key: "fresh-loss-key", conversationID: convID, agents: agents.NewRegistry(), dispatchRegistry: extcontext.NewDispatchRegistry(), pending: pending.New()}
	m.sessions[s.key] = s
	return m, s, func() []types.EngineEvent {
		mu.Lock()
		defer mu.Unlock()
		return append([]types.EngineEvent(nil), emitted...)
	}
}

func countLossEvents(events []types.EngineEvent) int {
	count := 0
	for _, event := range events {
		if event.Type == "engine_dispatch_lost" {
			count++
		}
	}
	return count
}

func TestDispatchLoss_PendingAnnouncementCannotOverwriteAcknowledgement(t *testing.T) {
	m, s, _ := lossTestEnv(t, "loss-ack-wins", []conversation.SessionEntry{
		dispatchEntry("dispatch-ack-wins", "worker", "running", ""),
	})

	m.persistLostNoticeState(s.conversationID, "dispatch-ack-wins", "sent")
	m.persistLostNoticeState(s.conversationID, "dispatch-ack-wins", "pending")

	m2, s2, events := freshLossSession(t, s.conversationID)
	m2.rehydrateDispatchState(s2, s2.key)
	m2.announceLostDispatches(s2, s2.key)
	if got := countLossEvents(events()); got != 0 {
		t.Fatalf("acknowledged loss re-announced %d times, want 0", got)
	}
}

func TestDispatchLoss_ConcurrentPersistencePreservesEveryLifecycleRecord(t *testing.T) {
	m, s, _ := lossTestEnv(t, "loss-concurrent-persist", nil)
	const dispatches = 16

	var registrations sync.WaitGroup
	for i := 0; i < dispatches; i++ {
		registrations.Add(1)
		go func(i int) {
			defer registrations.Done()
			id := fmt.Sprintf("dispatch-concurrent-%d", i)
			m.persistDispatchRegistered(s.key, s.conversationID, id, "worker", "Worker", "do work", "test-model", "", 1)
		}(i)
	}
	registrations.Wait()

	for i := 0; i < dispatches; i++ {
		id := fmt.Sprintf("dispatch-concurrent-%d", i)
		s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
			Name: fmt.Sprintf("worker-%d", i), ID: id, Status: "done",
			Metadata: map[string]interface{}{"task": "do work", "model": "test-model"},
		}, nil)
	}
	var terminals sync.WaitGroup
	for i := 0; i < dispatches; i++ {
		terminals.Add(1)
		go func() {
			defer terminals.Done()
			m.persistTerminalDispatches(s.key, s.conversationID)
		}()
	}
	terminals.Wait()

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	statuses := make(map[string]string)
	for _, entry := range conv.Entries {
		if dispatch := conversation.AsAgentDispatchData(entry.Data); dispatch != nil {
			statuses[dispatch.AgentID] = dispatch.Status
		}
	}
	if len(statuses) != dispatches {
		t.Fatalf("persisted dispatches = %d, want %d", len(statuses), dispatches)
	}
	for i := 0; i < dispatches; i++ {
		id := fmt.Sprintf("dispatch-concurrent-%d", i)
		if got := statuses[id]; got != "done" {
			t.Errorf("%s persisted status = %q, want done", id, got)
		}
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("ION_DATA_DIR"), "conversations", s.conversationID+".tree.jsonl.tmp")); !os.IsNotExist(err) {
		t.Errorf("tree temp file remains after concurrent saves: %v", err)
	}
}

// TestDispatchLoss_PerCompletionPersistSurvivesWithoutRunExit is the regression
// bar for the false-loss report: a dispatch that completes while its parent is
// parked must be durable WITHOUT any run exit. Before the per-completion write,
// the only terminal writer was the run-exit sweep, so a completed dispatch stayed
// on disk as `running`, the next start read it as an orphan, and a clean exit-0
// dispatch rendered red with "engine restarted while dispatch was running".
//
// The scoping half matters too: a sibling still running must not be dragged into
// the write, and must still be detected as lost on restart.
func TestDispatchLoss_PerCompletionPersistSurvivesWithoutRunExit(t *testing.T) {
	m, s, events := lossTestEnv(t, "loss-conv-percompletion", []conversation.SessionEntry{
		dispatchEntry("dispatch-finished-1", "finisher", "running", "conv-child-fin"),
		dispatchEntry("dispatch-inflight-1", "inflight", "running", "conv-child-fly"),
	})

	// Registry state at the moment ONE dispatch reaches its terminal status.
	// The sibling is still live; the parent has not exited a run and never will
	// before the simulated restart below.
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
		Name: "finisher", ID: "dispatch-finished-1", Status: "done",
		Metadata: map[string]interface{}{"task": "some task", "model": "test-model", "conversationId": "conv-child-fin"},
	}, nil)
	s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
		Name: "inflight", ID: "dispatch-inflight-1", Status: "running",
		Metadata: map[string]interface{}{"task": "some task", "model": "test-model"},
	}, nil)

	m.persistTerminalDispatch(s.key, s.conversationID, "dispatch-finished-1")

	// Restart: fresh registry, no run exit ever happened.
	s.agents = agents.NewRegistry()
	m.rehydrateDispatchState(s, s.key)

	statuses := make(map[string]string)
	for _, st := range s.agents.MergedSnapshot() {
		statuses[st.ID] = st.Status
	}
	if statuses["dispatch-finished-1"] != "done" {
		t.Fatalf("completed dispatch resolved to %q, want done (per-completion persist must not wait on a run exit)", statuses["dispatch-finished-1"])
	}
	if statuses["dispatch-inflight-1"] != "error" {
		t.Errorf("in-flight dispatch resolved to %q, want error (a genuine orphan)", statuses["dispatch-inflight-1"])
	}

	m.announceLostDispatches(s, s.key)
	var lostIDs []string
	for _, ev := range events() {
		if ev.Type == "engine_dispatch_lost" {
			lostIDs = append(lostIDs, ev.DispatchLost.DispatchID)
		}
	}
	if len(lostIDs) != 1 || lostIDs[0] != "dispatch-inflight-1" {
		t.Fatalf("loss announcements = %v, want only the genuine orphan dispatch-inflight-1", lostIDs)
	}
}

// TestDispatchLoss_PerCompletionPersistIsScopedToOneDispatch pins the filter
// itself at the file level: the per-completion writer touches only its own
// dispatch, even when another terminal row is sitting in the registry.
//
// Revert-red: drop the onlyID filter in persistTerminalDispatchesFiltered and
// the sibling's terminal row lands here too, turning every completion into a
// full sweep of the registry.
func TestDispatchLoss_PerCompletionPersistIsScopedToOneDispatch(t *testing.T) {
	m, s, _ := lossTestEnv(t, "loss-conv-scoped", []conversation.SessionEntry{
		dispatchEntry("dispatch-a", "agent-a", "running", ""),
		dispatchEntry("dispatch-b", "agent-b", "running", ""),
	})

	for _, id := range []string{"dispatch-a", "dispatch-b"} {
		s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
			Name: id, ID: id, Status: "done",
			Metadata: map[string]interface{}{"task": "some task", "model": "test-model"},
		}, nil)
	}

	m.persistTerminalDispatch(s.key, s.conversationID, "dispatch-a")

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	last := make(map[string]string)
	for _, entry := range conv.Entries {
		if d := conversation.AsAgentDispatchData(entry.Data); d != nil {
			last[d.AgentID] = d.Status
		}
	}
	if last["dispatch-a"] != "done" {
		t.Errorf("dispatch-a persisted status = %q, want done", last["dispatch-a"])
	}
	if last["dispatch-b"] != "running" {
		t.Errorf("dispatch-b persisted status = %q, want running (a per-completion write must not sweep siblings)", last["dispatch-b"])
	}
}
