package cost

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// writeTestHeader writes a minimal .llm.jsonl header for a test conversation.
func writeTestHeader(t *testing.T, dir, id, model string, inputTokens, outputTokens int, totalCost float64) {
	t.Helper()
	header := map[string]any{
		"meta":              true,
		"id":                id,
		"model":             model,
		"totalInputTokens":  inputTokens,
		"totalOutputTokens": outputTokens,
		"totalCost":         totalCost,
		"createdAt":         float64(1_700_000_000_000),
		"version":           float64(2),
	}
	b, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".llm.jsonl"), b, 0o644); err != nil {
		t.Fatalf("write llm header: %v", err)
	}
}

// TestConversationCostBreakdown_MixedModels verifies that ConversationCostBreakdown
// correctly attributes costs to models, sums the total, sorts rows descending,
// and aggregates same-model conversations into one row.
func TestConversationCostBreakdown_MixedModels(t *testing.T) {
	dir := t.TempDir()

	// Root conversation: opus, $10.00
	writeTestHeader(t, dir, "root", "claude-opus-4-5", 100_000, 3_000, 10.00)

	// Child 1: sonnet, $2.00
	writeTestHeader(t, dir, "child-sonnet", "claude-sonnet-4-6", 50_000, 2_000, 2.00)

	// Child 2: also sonnet, $1.50 — should aggregate with child-sonnet into one row
	writeTestHeader(t, dir, "child-sonnet-2", "claude-sonnet-4-6", 30_000, 1_500, 1.50)

	// Child 3: haiku, $0.30
	writeTestHeader(t, dir, "child-haiku", "claude-haiku-4-5", 20_000, 500, 0.30)

	// Children passed as liveIDs (root has no tree file, so no persisted dispatch
	// entries). walkCost handles a missing Load gracefully — returns header cost only.
	liveIDs := []string{"child-sonnet", "child-sonnet-2", "child-haiku"}

	total, breakdown, err := ConversationCostBreakdown("root", liveIDs, dir)
	if err != nil {
		t.Fatalf("ConversationCostBreakdown: %v", err)
	}

	wantTotal := 10.00 + 2.00 + 1.50 + 0.30 // 13.80
	if math.Abs(total-wantTotal) > 0.001 {
		t.Errorf("total = %.4f, want %.4f", total, wantTotal)
	}

	// Verify per-model aggregation.
	byModel := make(map[string]int) // model → index in breakdown
	for i, row := range breakdown {
		byModel[row.Model] = i
	}

	// Should have 3 distinct models.
	if len(breakdown) != 3 {
		t.Fatalf("len(breakdown) = %d, want 3", len(breakdown))
	}

	// Opus: 1 conversation, $10.00, 100k input tokens.
	opusIdx, ok := byModel["claude-opus-4-5"]
	if !ok {
		t.Error("missing opus row")
	} else {
		opus := breakdown[opusIdx]
		if opus.Conversations != 1 {
			t.Errorf("opus.Conversations = %d, want 1", opus.Conversations)
		}
		if math.Abs(opus.CostUsd-10.00) > 0.001 {
			t.Errorf("opus.CostUsd = %.4f, want 10.00", opus.CostUsd)
		}
		if opus.InputTokens != 100_000 {
			t.Errorf("opus.InputTokens = %d, want 100000", opus.InputTokens)
		}
		if opus.OutputTokens != 3_000 {
			t.Errorf("opus.OutputTokens = %d, want 3000", opus.OutputTokens)
		}
	}

	// Sonnet: 2 conversations, $3.50 combined, 80k input tokens.
	sonnetIdx, ok := byModel["claude-sonnet-4-6"]
	if !ok {
		t.Error("missing sonnet row")
	} else {
		sonnet := breakdown[sonnetIdx]
		if sonnet.Conversations != 2 {
			t.Errorf("sonnet.Conversations = %d, want 2", sonnet.Conversations)
		}
		if math.Abs(sonnet.CostUsd-3.50) > 0.001 {
			t.Errorf("sonnet.CostUsd = %.4f, want 3.50", sonnet.CostUsd)
		}
		if sonnet.InputTokens != 80_000 {
			t.Errorf("sonnet.InputTokens = %d, want 80000", sonnet.InputTokens)
		}
	}

	// Haiku: 1 conversation, $0.30.
	haikuIdx, ok := byModel["claude-haiku-4-5"]
	if !ok {
		t.Error("missing haiku row")
	} else {
		haiku := breakdown[haikuIdx]
		if math.Abs(haiku.CostUsd-0.30) > 0.001 {
			t.Errorf("haiku.CostUsd = %.4f, want 0.30", haiku.CostUsd)
		}
	}

	// Rows must be sorted descending by CostUsd.
	for i := 1; i < len(breakdown); i++ {
		if breakdown[i].CostUsd > breakdown[i-1].CostUsd {
			t.Errorf("breakdown not sorted desc: [%d]=%.4f > [%d]=%.4f",
				i, breakdown[i].CostUsd, i-1, breakdown[i-1].CostUsd)
		}
	}

	// Row totals must sum to the scalar total.
	var rowSum float64
	for _, r := range breakdown {
		rowSum += r.CostUsd
	}
	if math.Abs(rowSum-wantTotal) > 0.001 {
		t.Errorf("row sum = %.4f, want %.4f", rowSum, wantTotal)
	}
}

// TestConversationCostBreakdown_DelegatesToScalar verifies that ConversationCost
// returns the same total as ConversationCostBreakdown (the delegation contract:
// one walk, two return shapes).
func TestConversationCostBreakdown_DelegatesToScalar(t *testing.T) {
	dir := t.TempDir()
	writeTestHeader(t, dir, "root", "claude-opus-4-5", 50_000, 2_000, 5.00)
	writeTestHeader(t, dir, "child", "claude-sonnet-4-6", 20_000, 1_000, 1.00)

	scalarTotal, scalarErr := ConversationCost("root", []string{"child"}, dir)
	breakTotal, _, breakErr := ConversationCostBreakdown("root", []string{"child"}, dir)

	if scalarErr != nil {
		t.Fatalf("ConversationCost: %v", scalarErr)
	}
	if breakErr != nil {
		t.Fatalf("ConversationCostBreakdown: %v", breakErr)
	}
	if math.Abs(scalarTotal-breakTotal) > 0.0001 {
		t.Errorf("ConversationCost = %.6f, ConversationCostBreakdown total = %.6f — delegation contract violated",
			scalarTotal, breakTotal)
	}
}

// TestConversationCostBreakdown_EmptyConvID verifies the zero-value return for an empty ID.
func TestConversationCostBreakdown_EmptyConvID(t *testing.T) {
	total, breakdown, err := ConversationCostBreakdown("", nil, t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if total != 0 {
		t.Errorf("total = %v, want 0", total)
	}
	if len(breakdown) != 0 {
		t.Errorf("breakdown = %v, want empty", breakdown)
	}
}

// TestConversationCostBreakdown_VisitedSetDedup verifies that a conversation ID
// appearing in both the root's dispatch tree and liveIDs is counted only once.
func TestConversationCostBreakdown_VisitedSetDedup(t *testing.T) {	dir := t.TempDir()
	writeTestHeader(t, dir, "root", "claude-opus-4-5", 10_000, 500, 1.00)
	writeTestHeader(t, dir, "child", "claude-sonnet-4-6", 5_000, 200, 0.50)

	// Pass child both as a live ID; if the dedup works, it's counted once.
	total, breakdown, err := ConversationCostBreakdown("root", []string{"child", "child"}, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantTotal := 1.00 + 0.50
	if math.Abs(total-wantTotal) > 0.001 {
		t.Errorf("total = %.4f, want %.4f (dedup failed)", total, wantTotal)
	}
	// Sonnet should appear exactly once.
	sonnetCount := 0
	for _, row := range breakdown {
		if row.Model == "claude-sonnet-4-6" {
			sonnetCount++
			if row.Conversations != 1 {
				t.Errorf("sonnet.Conversations = %d, want 1 (dedup violated)", row.Conversations)
			}
		}
	}
	if sonnetCount != 1 {
		t.Errorf("sonnet rows = %d, want 1", sonnetCount)
	}
}

// TestConversationCostBreakdown_SelfVsDispatch verifies that the root/viewing
// conversation's own spend is reported as a distinct IsSelf=true row, separate
// from any dispatch that shares the same model. The scenario is an opus ROOT
// with opus AND sonnet DISPATCHES: opus must appear as TWO rows (one IsSelf=true
// count 1 for the root, one IsSelf=false count 2 for the dispatches), sonnet
// dispatches are IsSelf=false, and every row still sums to the scalar total.
func TestConversationCostBreakdown_SelfVsDispatch(t *testing.T) {
	dir := t.TempDir()

	// Root conversation: opus, $8.00 — this is the viewing conversation.
	writeTestHeader(t, dir, "root", "claude-opus-4-5", 120_000, 4_000, 8.00)

	// Two opus dispatches — same model as the root, but they are dispatches.
	writeTestHeader(t, dir, "disp-opus-1", "claude-opus-4-5", 60_000, 2_000, 4.00)
	writeTestHeader(t, dir, "disp-opus-2", "claude-opus-4-5", 40_000, 1_500, 3.00)

	// One sonnet dispatch.
	writeTestHeader(t, dir, "disp-sonnet", "claude-sonnet-4-6", 30_000, 1_000, 1.50)

	liveIDs := []string{"disp-opus-1", "disp-opus-2", "disp-sonnet"}

	total, breakdown, err := ConversationCostBreakdown("root", liveIDs, dir)
	if err != nil {
		t.Fatalf("ConversationCostBreakdown: %v", err)
	}

	wantTotal := 8.00 + 4.00 + 3.00 + 1.50 // 16.50
	if math.Abs(total-wantTotal) > 0.001 {
		t.Errorf("total = %.4f, want %.4f", total, wantTotal)
	}

	// Locate the rows: opus should appear twice (self + dispatch), sonnet once.
	var selfOpus, dispatchOpus, dispatchSonnet *struct {
		conversations int
		costUsd       float64
	}
	for i := range breakdown {
		row := breakdown[i]
		snap := &struct {
			conversations int
			costUsd       float64
		}{conversations: row.Conversations, costUsd: row.CostUsd}
		switch {
		case row.Model == "claude-opus-4-5" && row.IsSelf:
			selfOpus = snap
		case row.Model == "claude-opus-4-5" && !row.IsSelf:
			dispatchOpus = snap
		case row.Model == "claude-sonnet-4-6" && !row.IsSelf:
			dispatchSonnet = snap
		case row.Model == "claude-sonnet-4-6" && row.IsSelf:
			t.Error("sonnet must never be marked IsSelf — it is a dispatch")
		}
	}

	if selfOpus == nil {
		t.Fatal("missing IsSelf=true opus row for the root conversation")
	}
	if selfOpus.conversations != 1 {
		t.Errorf("self opus.Conversations = %d, want 1", selfOpus.conversations)
	}
	if math.Abs(selfOpus.costUsd-8.00) > 0.001 {
		t.Errorf("self opus.CostUsd = %.4f, want 8.00", selfOpus.costUsd)
	}

	if dispatchOpus == nil {
		t.Fatal("missing IsSelf=false opus dispatch row")
	}
	if dispatchOpus.conversations != 2 {
		t.Errorf("dispatch opus.Conversations = %d, want 2", dispatchOpus.conversations)
	}
	if math.Abs(dispatchOpus.costUsd-7.00) > 0.001 {
		t.Errorf("dispatch opus.CostUsd = %.4f, want 7.00", dispatchOpus.costUsd)
	}

	if dispatchSonnet == nil {
		t.Fatal("missing IsSelf=false sonnet dispatch row")
	}
	if dispatchSonnet.conversations != 1 {
		t.Errorf("dispatch sonnet.Conversations = %d, want 1", dispatchSonnet.conversations)
	}

	// The IsSelf row(s) must sort first.
	if !breakdown[0].IsSelf {
		t.Errorf("breakdown[0].IsSelf = false, want true (self rows sort first)")
	}
	// Non-self rows follow, sorted by CostUsd descending.
	for i := 1; i < len(breakdown); i++ {
		if breakdown[i].IsSelf {
			t.Errorf("breakdown[%d].IsSelf = true after a non-self row — self rows must be contiguous at the front", i)
		}
	}

	// All rows must still sum to the scalar total — the split is purely additive.
	var rowSum float64
	for _, r := range breakdown {
		rowSum += r.CostUsd
	}
	if math.Abs(rowSum-wantTotal) > 0.001 {
		t.Errorf("row sum = %.4f, want %.4f — self/dispatch split changed the total", rowSum, wantTotal)
	}
}
