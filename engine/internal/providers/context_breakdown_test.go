package providers

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// mockCountProvider is a provider stub that scripts CountTokens for the
// breakdown tests. It records how many times CountTokens was invoked so a
// test can assert the content-hash cache prevents re-counting.
type mockCountProvider struct {
	result int
	calls  int
	fail   bool
}

func (m *mockCountProvider) ID() string { return "mock-count" }

func (m *mockCountProvider) Stream(_ context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	ev := make(chan types.LlmStreamEvent)
	errc := make(chan error, 1)
	close(ev)
	close(errc)
	return ev, errc
}

func (m *mockCountProvider) CountTokens(_ context.Context, _ CountTokensRequest) (int, error) {
	m.calls++
	if m.fail {
		return 0, ErrCountUnsupported
	}
	return m.result, nil
}

func resetBreakdownCache() {
	breakdownCache.Range(func(k, _ any) bool {
		breakdownCache.Delete(k)
		return true
	})
}

func TestBuildContextBreakdown_ThreeTierLabels(t *testing.T) {
	resetBreakdownCache()
	opts := &types.LlmStreamOptions{
		Model:    "gpt-4o",
		System:   "you are a bot",
		Messages: []types.LlmMessage{{Role: "user", Content: "hello world"}},
	}

	// Nil provider → no network → local BPE (gpt-4o has an encoder) or approximate.
	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, c := range bd.Categories {
		if c.Kind == "unaccounted" {
			continue
		}
		// tool_overhead is a synthetic exact row; skip.
		if c.Name == "tool_overhead" {
			continue
		}
		if c.Tier != TierLocal && c.Tier != TierApproximate {
			t.Errorf("nil-provider row %q tier = %q, want local/approximate", c.Name, c.Tier)
		}
	}

	// Mock provider that succeeds → all counted rows should be exact.
	resetBreakdownCache()
	mp := &mockCountProvider{result: 7}
	bd2, err := BuildContextBreakdown(context.Background(), "gpt-4o", mp, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, c := range bd2.Categories {
		if c.Name == "tool_overhead" || c.Kind == "unaccounted" {
			continue
		}
		if c.Tier != TierExact {
			t.Errorf("provider row %q tier = %q, want exact", c.Name, c.Tier)
		}
	}
}

func TestBuildContextBreakdown_ToolOverhead(t *testing.T) {
	resetBreakdownCache()
	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Tools: []types.LlmToolDef{
			{Name: "Read", Description: "read", InputSchema: map[string]any{"type": "object"}},
			{Name: "Write", Description: "write", InputSchema: map[string]any{"type": "object"}},
			{Name: "Edit", Description: "edit", InputSchema: map[string]any{"type": "object"}},
		},
	}
	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var overheadRow *BreakdownCategory
	toolRowCount := 0
	for i := range bd.Categories {
		c := &bd.Categories[i]
		if c.Kind == "tool" {
			toolRowCount++
		}
		if c.Name == "tool_overhead" {
			overheadRow = c
		}
	}
	if toolRowCount != 4 { // 3 tools + 1 overhead
		t.Fatalf("expected 4 tool-kind rows (3 tools + overhead), got %d", toolRowCount)
	}
	if overheadRow == nil {
		t.Fatalf("expected a tool_overhead row")
	}
	if overheadRow.Tokens != -ToolTokenCountOverhead {
		t.Fatalf("tool_overhead tokens = %d, want %d", overheadRow.Tokens, -ToolTokenCountOverhead)
	}
}

func TestBuildContextBreakdown_Cache(t *testing.T) {
	resetBreakdownCache()
	opts := &types.LlmStreamOptions{
		Model:    "gpt-4o",
		System:   "identical system prompt",
		Messages: []types.LlmMessage{{Role: "user", Content: "identical message"}},
	}
	mp := &mockCountProvider{result: 5}

	if _, err := BuildContextBreakdown(context.Background(), "gpt-4o", mp, opts, nil, nil, ""); err != nil {
		t.Fatalf("first build error: %v", err)
	}
	firstCalls := mp.calls
	if firstCalls == 0 {
		t.Fatalf("expected provider CountTokens to be called at least once")
	}

	// Second build with identical content must hit the cache — no new calls.
	if _, err := BuildContextBreakdown(context.Background(), "gpt-4o", mp, opts, nil, nil, ""); err != nil {
		t.Fatalf("second build error: %v", err)
	}
	if mp.calls != firstCalls {
		t.Fatalf("cache miss: provider called %d times on second build (want %d)", mp.calls, firstCalls)
	}
}

func TestReconcileBreakdown_DriftRow(t *testing.T) {
	bd := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 100, Tier: TierLocal}},
		TotalTokens: 100,
		Model:       "gpt-4o",
	}
	ReconcileBreakdown(bd, 223) // itemized 100 + 123 drift

	if bd.Unaccounted != 123 {
		t.Fatalf("Unaccounted = %d, want 123", bd.Unaccounted)
	}
	if bd.APIReportedTotal != 223 {
		t.Fatalf("APIReportedTotal = %d, want 223", bd.APIReportedTotal)
	}
	found := false
	for _, c := range bd.Categories {
		if c.Kind == "unaccounted" {
			found = true
			if c.Tokens != 123 {
				t.Fatalf("unaccounted row tokens = %d, want 123", c.Tokens)
			}
		}
	}
	if !found {
		t.Fatalf("expected an unaccounted category row after reconcile")
	}
}

func TestReconcileBreakdown_NoSilentAbsorption(t *testing.T) {
	bd := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 50, Tier: TierLocal}},
		TotalTokens: 50,
		Model:       "gpt-4o",
	}
	before := len(bd.Categories)
	ReconcileBreakdown(bd, 60) // drift = 10, must NOT be folded into "system"

	if len(bd.Categories) != before+1 {
		t.Fatalf("expected exactly one appended row, got %d new", len(bd.Categories)-before)
	}
	// The original system row must be untouched.
	if bd.Categories[0].Tokens != 50 {
		t.Fatalf("system row mutated: tokens = %d, want 50", bd.Categories[0].Tokens)
	}
	last := bd.Categories[len(bd.Categories)-1]
	if last.Kind != "unaccounted" || last.Tokens != 10 {
		t.Fatalf("drift not surfaced as unaccounted row: got kind=%q tokens=%d", last.Kind, last.Tokens)
	}
}
