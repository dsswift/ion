package session

// dispatch_fanout_persist_test.go — the fan-out durability case: concurrent
// dispatch registrations must all reach disk.
//
// The production failure this pins: a four-agent fan-out registered four
// dispatches at once, each of which loaded the same conversation file,
// appended its own `running` record, and saved. The saves were unserialized,
// so the last one overwrote the rest and three records vanished — leaving
// dispatch-loss detection blind for exactly the dispatches most likely to be
// orphaned by an engine restart. Two engine.jsonl signatures accompanied it:
// "persistdispatchregistered: save failed ... rename <id>.llm.jsonl.tmp: no
// such file or directory" (the shared temp-file race) and, silently, the
// missing records themselves.

import (
	"fmt"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

// TestDispatchFanout_ConcurrentRegistrationsAllPersist registers N dispatches
// concurrently against one conversation and asserts every record is on disk.
func TestDispatchFanout_ConcurrentRegistrationsAllPersist(t *testing.T) {
	m, s, _ := lossTestEnv(t, "fanout-conv-1", nil)

	const fanout = 8
	var wg sync.WaitGroup
	for i := 0; i < fanout; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("dispatch-fanout-%d", n)
			m.persistDispatchRegistered(s.key, s.conversationID, id, "chief", "Chief", "do work", "test-model", "", 1)
		}(i)
	}
	wg.Wait()

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	found := map[string]string{} // AgentID -> status
	for _, e := range conv.Entries {
		if e.Type != conversation.EntryAgentDispatch {
			continue
		}
		if ad := conversation.AsAgentDispatchData(e.Data); ad != nil {
			found[ad.AgentID] = ad.Status
		}
	}

	if len(found) != fanout {
		t.Fatalf("persisted dispatch records = %d, want %d (concurrent registrations lost)", len(found), fanout)
	}
	for i := 0; i < fanout; i++ {
		id := fmt.Sprintf("dispatch-fanout-%d", i)
		status, ok := found[id]
		if !ok {
			t.Errorf("dispatch %q missing from conversation file", id)
			continue
		}
		if status != "running" {
			t.Errorf("dispatch %q status = %q, want running", id, status)
		}
	}
}

// TestDispatchFanout_ConcurrentTerminalPersistsSupersedeAll is the other half
// of the lifecycle: every dispatch's terminal transition must land even when
// the fan-out completes simultaneously. A lost terminal record reads as
// `running` on the next start and fires a false engine_dispatch_lost.
func TestDispatchFanout_ConcurrentTerminalPersistsSupersedeAll(t *testing.T) {
	m, s, _ := lossTestEnv(t, "fanout-conv-2", nil)

	const fanout = 6
	ids := make([]string, fanout)
	for i := range ids {
		ids[i] = fmt.Sprintf("dispatch-term-%d", i)
		m.persistDispatchRegistered(s.key, s.conversationID, ids[i], "chief", "Chief", "do work", "test-model", "", 1)
	}

	// Drive the terminal persists concurrently through the same funnel the
	// run-exit path uses.
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		go func(agentID string) {
			defer wg.Done()
			err := conversation.UpdateOnDisk(s.conversationID, "", func(conv *conversation.Conversation) (bool, error) {
				conversation.AppendDetachedEntry(conv, conversation.SessionEntry{
					ID:   agentID + "-done",
					Type: conversation.EntryAgentDispatch,
					Data: conversation.AgentDispatchData{
						AgentName: "chief",
						AgentID:   agentID,
						Status:    "done",
					},
				})
				return true, nil
			})
			if err != nil {
				t.Errorf("terminal persist for %s: %v", agentID, err)
			}
		}(id)
	}
	wg.Wait()

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// Last-entry-wins per dispatch, matching rehydrate's resolution.
	resolved := map[string]string{}
	for _, e := range conv.Entries {
		if e.Type != conversation.EntryAgentDispatch {
			continue
		}
		if ad := conversation.AsAgentDispatchData(e.Data); ad != nil {
			resolved[ad.AgentID] = ad.Status
		}
	}
	if len(resolved) != fanout {
		t.Fatalf("resolved dispatches = %d, want %d", len(resolved), fanout)
	}
	for _, id := range ids {
		if resolved[id] != "done" {
			t.Errorf("dispatch %q resolved status = %q, want done", id, resolved[id])
		}
	}
}
