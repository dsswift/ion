package session_test

// aggregate_cost_test.go — regression tests for the ConversationCost walk
// as consumed from the session package. These tests live in the session_test
// package (external test) so they import cost explicitly and verify the
// integration between session persistence and the cost calculator.
//
// The canonical unit tests for cost.ConversationCost and cost.TurnCost live
// in engine/internal/cost/cost_test.go.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
)

// writeConvWithCostSess creates and persists a split-format conversation with
// the given id, cost, and dispatch child conversation IDs.
func writeConvWithCostSess(t *testing.T, dir, id string, c float64, children ...string) string {
	t.Helper()
	conv := conversation.CreateConversation(id, "system", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "prompt")
	conv.TotalCost = c

	for _, childID := range children {
		dispatch := conversation.AgentDispatchData{
			AgentName:       "worker",
			AgentID:         id + "-dispatch-" + childID,
			Status:          "done",
			ConversationID:  childID,
			ConversationIDs: []string{childID},
		}
		conv.Entries = append(conv.Entries, conversation.SessionEntry{
			ID:       dispatch.AgentID,
			Type:     conversation.EntryAgentDispatch,
			Data:     dispatch,
			ParentID: nil,
		})
	}

	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("Save %s: %v", id, err)
	}
	return id
}

// TestComputeAggregateCost_EmptyConvID verifies an empty conversation ID
// returns (0, nil) immediately without touching disk.
func TestComputeAggregateCost_EmptyConvID(t *testing.T) {
	total, err := cost.ConversationCost("", nil, "")
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %f, want 0 for empty convID", total)
	}
}

// TestComputeAggregateCost_FreshConversation verifies a conversation with no
// cost and no dispatches aggregates to 0.
func TestComputeAggregateCost_FreshConversation(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCostSess(t, dir, "fresh", 0)

	total, err := cost.ConversationCost("fresh", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %f, want 0", total)
	}
}

// TestComputeAggregateCost_TwoChildren verifies a historical top-level
// conversation with two child dispatches sums own + child1 + child2.
func TestComputeAggregateCost_TwoChildren(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCostSess(t, dir, "child1", 0.02)
	writeConvWithCostSess(t, dir, "child2", 0.03)
	writeConvWithCostSess(t, dir, "top", 0.10, "child1", "child2")

	total, err := cost.ConversationCost("top", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.15
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// TestComputeAggregateCost_NTier verifies transitive descent: top -> child ->
// grandchild produces the three-way sum.
func TestComputeAggregateCost_NTier(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCostSess(t, dir, "grandchild", 0.05)
	writeConvWithCostSess(t, dir, "child", 0.03, "grandchild")
	writeConvWithCostSess(t, dir, "top", 0.10, "child")

	total, err := cost.ConversationCost("top", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.18
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// TestComputeAggregateCost_CycleAndDupGuard verifies a conversation ID that
// appears in multiple dispatch entries (and self-references) is counted once.
func TestComputeAggregateCost_CycleAndDupGuard(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCostSess(t, dir, "child", 0.04)

	conv := conversation.CreateConversation("top", "system", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "prompt")
	conv.TotalCost = 0.10
	var counter int
	for _, target := range []string{"child", "child", "top"} {
		counter++
		suffix := string(rune('a' + (counter % 26)))
		dispatch := conversation.AgentDispatchData{
			AgentName:      "worker",
			AgentID:        "top-dispatch-" + target + "-" + suffix,
			Status:         "done",
			ConversationID: target,
		}
		conv.Entries = append(conv.Entries, conversation.SessionEntry{
			ID:   dispatch.AgentID,
			Type: conversation.EntryAgentDispatch,
			Data: dispatch,
		})
	}
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("Save top: %v", err)
	}

	total, err := cost.ConversationCost("top", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.14 // top(0.10) + child(0.04), each counted once.
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f (dup/cycle not deduped)", total, want)
	}
}

// TestComputeAggregateCost_LiveConvIDsDedup verifies a conversation ID present
// in both the persisted tree and the liveConvIDs list is counted once.
func TestComputeAggregateCost_LiveConvIDsDedup(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCostSess(t, dir, "child", 0.04)
	writeConvWithCostSess(t, dir, "live-only", 0.06)
	writeConvWithCostSess(t, dir, "top", 0.10, "child")

	total, err := cost.ConversationCost("top", []string{"child", "live-only"}, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.20 // top(0.10) + child(0.04) + live-only(0.06); child once.
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}
