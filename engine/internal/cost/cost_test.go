package cost_test

// cost_test.go — tests for ConversationCost and TurnCost.
//
// Reconciliation test: two fixtures share the same logical tree
// (root → sub-agent-A → grandchild-B, true total $0.30). Fixture A stores
// own-costs; ConversationCost returns $0.30. Fixture B stores cumulative
// subtree totals (root=$0.30, A=$0.20, B=$0.05); ConversationCost faithfully
// sums those stored values and returns $0.55, proving the divergence between
// correct own-cost storage ($0.30) and naive cumulative storage ($0.55). The
// pair of assertions pins that the walk sums ALL nodes AND that own-cost
// storage is the required invariant for a correct total.
//
// TurnCost cache-aware test: pins cache-aware TurnCost against known token
// counts using a registered test model.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// writeConvWithCost creates and persists a split-format conversation with the
// given id, cost, and dispatch child conversation IDs. Each entry in children
// becomes an AgentDispatchData with a single ConversationID. It returns the
// conversation id for convenience.
func writeConvWithCost(t *testing.T, dir, id string, cost float64, children ...string) string {
	t.Helper()
	conv := conversation.CreateConversation(id, "system", "claude-sonnet-4-6")
	// A non-empty Entries list triggers the split save path.
	conversation.AddUserMessage(conv, "prompt")
	conv.TotalCost = cost

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

// TestConversationCost_EmptyConvID verifies an empty conversation ID
// returns (0, nil) immediately without touching disk.
func TestConversationCost_EmptyConvID(t *testing.T) {
	total, err := cost.ConversationCost("", nil, "")
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %f, want 0 for empty convID", total)
	}
}

// TestConversationCost_FreshConversation verifies a conversation with no
// cost and no dispatches aggregates to 0.
func TestConversationCost_FreshConversation(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCost(t, dir, "fresh", 0)

	total, err := cost.ConversationCost("fresh", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %f, want 0", total)
	}
}

// TestConversationCost_TwoChildren verifies a historical top-level
// conversation with two child dispatches sums own + child1 + child2.
func TestConversationCost_TwoChildren(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCost(t, dir, "child1", 0.02)
	writeConvWithCost(t, dir, "child2", 0.03)
	writeConvWithCost(t, dir, "top", 0.10, "child1", "child2")

	total, err := cost.ConversationCost("top", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.15
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// TestConversationCost_NTier verifies transitive descent: top -> child ->
// grandchild produces the three-way sum.
func TestConversationCost_NTier(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCost(t, dir, "grandchild", 0.05)
	writeConvWithCost(t, dir, "child", 0.03, "grandchild")
	writeConvWithCost(t, dir, "top", 0.10, "child")

	total, err := cost.ConversationCost("top", nil, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.18
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// TestConversationCost_CycleAndDupGuard verifies a conversation ID that
// appears in multiple dispatch entries (and self-references) is counted once.
func TestConversationCost_CycleAndDupGuard(t *testing.T) {
	dir := t.TempDir()
	// child referenced twice from top; and top references itself (cycle).
	writeConvWithCost(t, dir, "child", 0.04)

	conv := conversation.CreateConversation("top", "system", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "prompt")
	conv.TotalCost = 0.10
	// Two dispatch entries pointing at the same child, plus a self-reference.
	for _, target := range []string{"child", "child", "top"} {
		dispatch := conversation.AgentDispatchData{
			AgentName:      "worker",
			AgentID:        "top-dispatch-" + target + "-" + randSuffix(),
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

	total, err := cost.ConversationCost("top", []string(nil), dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.14 // top(0.10) + child(0.04), each counted once.
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f (dup/cycle not deduped)", total, want)
	}
}

// TestConversationCost_LiveConvIDsDedup verifies a conversation ID present
// in both the persisted tree and the liveConvIDs list is counted once.
func TestConversationCost_LiveConvIDsDedup(t *testing.T) {
	dir := t.TempDir()
	writeConvWithCost(t, dir, "child", 0.04)
	writeConvWithCost(t, dir, "live-only", 0.06)
	writeConvWithCost(t, dir, "top", 0.10, "child")

	// "child" appears in both the tree and liveConvIDs; "live-only" is only in
	// liveConvIDs (an in-flight dispatch whose tree entry is not yet persisted).
	total, err := cost.ConversationCost("top", []string{"child", "live-only"}, dir)
	if err != nil {
		t.Fatalf("ConversationCost: %v", err)
	}
	want := 0.20 // top(0.10) + child(0.04) + live-only(0.06); child once.
	if total < want-1e-9 || total > want+1e-9 {
		t.Errorf("total = %f, want %f", total, want)
	}
}

// TestReconciliation is the definitive regression test for correctness of the
// cost calculator under a sub-agent tree.
//
// Two fixtures, same logical tree:
//
//	root → sub-agent-A → grandchild-B
//
// Fixture A — own-cost (correct): each node stores only the tokens IT spent.
//
//	root=$0.10, sub-agent-A=$0.15, grandchild-B=$0.05. True total=$0.30.
//
// Fixture B — cumulative (wrong storage): each node stores its own subtree
// total, as a naive implementation might do.
//
//	root=$0.30, sub-agent-A=$0.20, grandchild-B=$0.05.
//	Naively summing the stored values gives $0.55 — double-counting A and B.
//
// The test asserts:
//  1. cost.ConversationCost on the own-cost fixture == $0.30 (correct walk).
//  2. cost.ConversationCost on the cumulative fixture == $0.55 (diverges from
//     the true $0.30), proving the calculator does not compensate for bad
//     storage — if any node ever stored a cumulative, the result would inflate.
//     This assertion would FAIL (go red) if ConversationCost were changed to
//     walk only root-level own-cost, because then $0.30 == $0.30 and the
//     divergence would disappear. It pins that the walk sums ALL nodes.
//  3. root-only LoadLlmHeaderCost(root) == $0.10 (no descendants).
func TestReconciliation(t *testing.T) {
	const eps = 1e-9

	// ── Fixture A: each node stores its OWN cost only ──────────────────────
	dirA := t.TempDir()
	writeConvWithCost(t, dirA, "grandchild-B", 0.05)
	writeConvWithCost(t, dirA, "sub-agent-A", 0.15, "grandchild-B")
	writeConvWithCost(t, dirA, "root", 0.10, "sub-agent-A")

	// 1. Correct calculator on own-cost fixture returns $0.30.
	const wantTrue = 0.30
	total, err := cost.ConversationCost("root", nil, dirA)
	if err != nil {
		t.Fatalf("ConversationCost (own-cost fixture): %v", err)
	}
	if total < wantTrue-eps || total > wantTrue+eps {
		t.Errorf("ConversationCost (own-cost) = %f, want %f", total, wantTrue)
	}

	// ── Fixture B: each node stores a CUMULATIVE subtree total ─────────────
	// root=$0.30 (entire tree), sub-agent-A=$0.20 (A+B), grandchild-B=$0.05.
	// A naive sum of stored values = $0.30+$0.20+$0.05 = $0.55 (inflated).
	dirB := t.TempDir()
	writeConvWithCost(t, dirB, "grandchild-B", 0.05)
	writeConvWithCost(t, dirB, "sub-agent-A", 0.20, "grandchild-B") // cumulative: A+B
	writeConvWithCost(t, dirB, "root", 0.30, "sub-agent-A")         // cumulative: root+A+B

	// 2. ConversationCost on the cumulative fixture returns $0.55 — it faithfully
	//    sums what the nodes store. The divergence from $0.30 proves two things:
	//    (a) the correct walk does sum ALL nodes (not just root), and
	//    (b) correct storage (own-cost) is required for a correct total.
	//    If ConversationCost were changed to sum cumulatives it would return
	//    $0.55 on fixture A too, and assertion #1 above would go red.
	const wantInflated = 0.55
	totalCumulative, err := cost.ConversationCost("root", nil, dirB)
	if err != nil {
		t.Fatalf("ConversationCost (cumulative fixture): %v", err)
	}
	if totalCumulative < wantInflated-eps || totalCumulative > wantInflated+eps {
		t.Errorf("ConversationCost (cumulative) = %f, want %f (naive-sum inflation not reproduced)", totalCumulative, wantInflated)
	}
	// Sanity: the two fixtures diverge — own-cost $0.30 vs cumulative $0.55.
	if total >= totalCumulative-eps {
		t.Errorf("expected own-cost total (%f) < cumulative total (%f); divergence not detected", total, totalCumulative)
	}

	// 3. Root-only lookup returns $0.10 (own-cost of root alone).
	rootOnly, err := conversation.LoadLlmHeaderCost("root", dirA)
	if err != nil {
		t.Fatalf("LoadLlmHeaderCost root: %v", err)
	}
	const wantRoot = 0.10
	if rootOnly < wantRoot-eps || rootOnly > wantRoot+eps {
		t.Errorf("root-only cost = %f, want %f", rootOnly, wantRoot)
	}
}

// TestTurnCost_CacheAware verifies TurnCost uses cache-aware pricing:
// cache-creation tokens at 1.25× input, cache-read at 0.1× input (fallback
// rates applied because the test model has no explicit cache fields).
func TestTurnCost_CacheAware(t *testing.T) {
	// Register a test model with known pricing.
	const model = "test-cost-cache-model"
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:      "test",
		CostPer1kInput:  1.0,  // $1.00 per 1k input tokens
		CostPer1kOutput: 2.0,  // $2.00 per 1k output tokens
		// No explicit cache pricing — fallbacks apply:
		//   creation = 1.25 * $1.00 = $1.25/1k
		//   read     = 0.10 * $1.00 = $0.10/1k
	})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	usage := types.LlmUsage{
		InputTokens:              1000, // $1.00
		OutputTokens:             500,  // $1.00
		CacheCreationInputTokens: 2000, // $2.50 (1.25 * $1.00 * 2)
		CacheReadInputTokens:     4000, // $0.40 (0.10 * $1.00 * 4)
	}
	// Expected: $1.00 + $1.00 + $2.50 + $0.40 = $4.90
	got := cost.TurnCost(model, usage)
	const want = 4.90
	const eps = 1e-9
	if got < want-eps || got > want+eps {
		t.Errorf("TurnCost = %f, want %f", got, want)
	}
}

// TestTurnCost_ExplicitCachePricing verifies that when a model carries
// explicit CostPer1kCacheCreation and CostPer1kCacheRead rates, TurnCost
// uses those rates rather than the fallback multipliers.
func TestTurnCost_ExplicitCachePricing(t *testing.T) {
	const model = "test-cost-explicit-cache-model"
	providers.RegisterModel(model, types.ModelInfo{
		ProviderID:             "test",
		CostPer1kInput:         1.0,
		CostPer1kOutput:        2.0,
		CostPer1kCacheCreation: 0.80, // explicit: $0.80/1k (not 1.25×)
		CostPer1kCacheRead:     0.05, // explicit: $0.05/1k (not 0.10×)
	})
	t.Cleanup(func() { providers.UnregisterModel(model) })

	usage := types.LlmUsage{
		InputTokens:              1000, // $1.00
		OutputTokens:             1000, // $2.00
		CacheCreationInputTokens: 1000, // $0.80
		CacheReadInputTokens:     1000, // $0.05
	}
	// Expected: $1.00 + $2.00 + $0.80 + $0.05 = $3.85
	got := cost.TurnCost(model, usage)
	const want = 3.85
	const eps = 1e-9
	if got < want-eps || got > want+eps {
		t.Errorf("TurnCost = %f, want %f", got, want)
	}
}

// TestTurnCost_UnknownModel returns 0 for a model not in the registry.
func TestTurnCost_UnknownModel(t *testing.T) {
	got := cost.TurnCost("completely-unknown-model-xyz-cost-test", types.LlmUsage{
		InputTokens:  1000,
		OutputTokens: 1000,
	})
	if got != 0 {
		t.Errorf("TurnCost for unknown model = %f, want 0", got)
	}
}

// randSuffix returns a short unique-ish suffix so AgentIDs in tests are
// distinct even when they point at the same conversation.
var randCounter int

func randSuffix() string {
	randCounter++
	return string(rune('a' + (randCounter % 26)))
}
