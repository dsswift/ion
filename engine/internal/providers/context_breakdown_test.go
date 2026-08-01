package providers

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
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

// scriptedCountProvider returns a caller-supplied token count based on the
// shape of the request (tools-only batch vs. messages-only conversation),
// letting a test wire distinct values for each CountTokens call path.
type scriptedCountProvider struct {
	fn func(req CountTokensRequest) (int, error)
}

func (s *scriptedCountProvider) ID() string { return "scripted-count" }

func (s *scriptedCountProvider) Stream(_ context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	ev := make(chan types.LlmStreamEvent)
	errc := make(chan error, 1)
	close(ev)
	close(errc)
	return ev, errc
}

func (s *scriptedCountProvider) CountTokens(_ context.Context, req CountTokensRequest) (int, error) {
	return s.fn(req)
}

func resetBreakdownCache() {
	breakdownCache.Range(func(k, _ any) bool {
		breakdownCache.Delete(k)
		return true
	})
}

type contextAwareCountProvider struct {
	started chan struct{}
}

func (p *contextAwareCountProvider) ID() string { return "context-aware-count" }

func (p *contextAwareCountProvider) Stream(_ context.Context, _ types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent)
	errs := make(chan error, 1)
	close(events)
	close(errs)
	return events, errs
}

func (p *contextAwareCountProvider) CountTokens(ctx context.Context, _ CountTokensRequest) (int, error) {
	close(p.started)
	<-ctx.Done()
	return 0, ctx.Err()
}

func TestBuildContextBreakdownCancellationDoesNotFallback(t *testing.T) {
	resetBreakdownCache()
	ctx, cancel := context.WithCancel(context.Background())
	provider := &contextAwareCountProvider{started: make(chan struct{})}
	result := make(chan error, 1)
	go func() {
		_, err := BuildContextBreakdown(ctx, "gpt-4o", provider, &types.LlmStreamOptions{
			Model:  "gpt-4o",
			System: "must not be locally counted after cancellation",
		}, nil, nil, "")
		result <- err
	}()
	<-provider.started
	cancel()

	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("BuildContextBreakdown error = %v, want context.Canceled", err)
	}
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
		if c.Kind == "unaccounted" {
			continue
		}
		if c.Tier != TierExact {
			t.Errorf("provider row %q tier = %q, want exact", c.Name, c.Tier)
		}
	}
}

func TestBuildContextBreakdown_NoBatchNegativeRows(t *testing.T) {
	resetBreakdownCache()
	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Tools: []types.LlmToolDef{
			{Name: "Read", Description: "read", InputSchema: map[string]any{"type": "object"}},
			{Name: "Write", Description: "write", InputSchema: map[string]any{"type": "object"}},
			{Name: "Edit", Description: "edit", InputSchema: map[string]any{"type": "object"}},
		},
	}
	// nil provider → local fallback; three tool rows, no tool_overhead, none negative.
	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	toolRowCount := 0
	for _, c := range bd.Categories {
		if c.Name == "tool_overhead" {
			t.Fatalf("tool_overhead row must not exist after batch tool count")
		}
		if c.Kind == "tool" {
			toolRowCount++
		}
		if c.Tokens < 0 {
			t.Fatalf("row %q has negative tokens=%d", c.Name, c.Tokens)
		}
	}
	if toolRowCount != 3 {
		t.Fatalf("expected exactly 3 tool rows (one per tool), got %d", toolRowCount)
	}
}

func TestBuildContextBreakdown_BatchMinusOverhead(t *testing.T) {
	resetBreakdownCache()
	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Tools: []types.LlmToolDef{
			{Name: "Read", Description: "read", InputSchema: map[string]any{"type": "object"}},
			{Name: "Write", Description: "write", InputSchema: map[string]any{"type": "object"}},
			{Name: "Edit", Description: "edit", InputSchema: map[string]any{"type": "object"}},
		},
	}
	const batchReported = 800 // provider returns 800 for the tools batch
	prov := &scriptedCountProvider{fn: func(req CountTokensRequest) (int, error) {
		if len(req.Tools) > 0 {
			return batchReported, nil
		}
		return 0, ErrCountUnsupported
	}}

	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", prov, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sumTools := 0
	for _, c := range bd.Categories {
		if c.Kind == "tool" {
			sumTools += c.Tokens
			if c.Tier != TierExact {
				t.Errorf("tool row %q tier = %q, want exact", c.Name, c.Tier)
			}
		}
	}
	// The per-tool rows are a proportional distribution of (batchReported -
	// overhead). Integer division can lose a few tokens to rounding, so the sum
	// must be <= the content-only total and within (numTools) of it.
	want := batchReported - ToolTokenCountOverhead
	if sumTools > want || sumTools < want-len(opts.Tools) {
		t.Fatalf("sum of tool rows = %d, want ~%d (batch - overhead)", sumTools, want)
	}
}

func TestBuildContextBreakdown_StructuredVsBlob(t *testing.T) {
	resetBreakdownCache()
	// A conversation with a tool_result + image-like block: the marshaled JSON
	// blob is much larger (structural noise) than the structured count the
	// provider would actually bill. The scripted provider models this: it
	// returns a small structured count for the messages-only call, but if the
	// old blob path were used it would pass a giant "user" string whose local
	// count would dwarf the structured value.
	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Messages: []types.LlmMessage{
			{Role: "user", Content: "describe this"},
			{Role: "assistant", Content: []map[string]any{
				{"type": "tool_use", "id": "t1", "name": "Read", "input": map[string]any{"path": "/a"}},
			}},
			{Role: "user", Content: []map[string]any{
				{"type": "tool_result", "tool_use_id": "t1", "content": "lots of file text here"},
				{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "AAAA"}},
			}},
		},
	}

	const structured = 42
	prov := &scriptedCountProvider{fn: func(req CountTokensRequest) (int, error) {
		if len(req.Messages) > 0 && len(req.Tools) == 0 {
			return structured, nil
		}
		return 0, ErrCountUnsupported
	}}

	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", prov, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var convRow *BreakdownCategory
	for i := range bd.Categories {
		if bd.Categories[i].Kind == "conversation" {
			convRow = &bd.Categories[i]
		}
	}
	if convRow == nil {
		t.Fatalf("expected a conversation row")
	}
	if convRow.Tokens != structured {
		t.Fatalf("conversation tokens = %d, want %d (structured count, not JSON blob)", convRow.Tokens, structured)
	}
	if convRow.Tier != TierExact {
		t.Fatalf("conversation tier = %q, want exact", convRow.Tier)
	}

	// Sanity: the old blob path would count the marshaled JSON, which is far
	// larger than the structured value — proving structured != blob.
	blobJSON, _ := json.Marshal(opts.Messages)
	blobCount, _, _ := LocalTokenCount("gpt-4o", string(blobJSON))
	if blobCount <= structured {
		t.Fatalf("test precondition failed: blob count %d not larger than structured %d", blobCount, structured)
	}
}

// ---------------------------------------------------------------------------
// Image blocks must not be counted by base64 byte length
// ---------------------------------------------------------------------------
//
// An image block's wire form carries its full base64 payload in source.data,
// which can be megabytes, while the provider charges a roughly fixed per-image
// cost. Counting the payload by length inflated one real conversation from the
// 255,897 tokens the provider billed to an itemized 1,034,443 — 59% of its bytes
// were base64 — which a client then rendered as >100% context on a 1M window.
//
// These exercise the LOCAL-FALLBACK path (nil provider). The provider-exact path
// needs no adjustment: the provider is authoritative about how it bills images.

// TestBuildContextBreakdown_ImageBytesNotCountedAsText pins that the
// conversation row does not scale with a large base64 payload, in the typed
// []LlmContentBlock shape.
//
// Fails before the fix: the row scales with the payload (a ~600KB base64 string
// counts as ~150K tokens instead of the fixed per-image estimate).
func TestBuildContextBreakdown_ImageBytesNotCountedAsText(t *testing.T) {
	resetBreakdownCache()

	// Large enough that byte-length counting is unmistakable — ~60K chars of
	// base64 is ~15K tokens at char/4, an order of magnitude above the ceiling
	// below — while staying small enough that the BPE precondition encode below
	// runs in milliseconds rather than minutes.
	bigPayload := strings.Repeat("A", 60_000)

	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Messages: []types.LlmMessage{
			{Role: "user", Content: []types.LlmContentBlock{
				{Type: "text", Text: "describe this screenshot"},
				{Type: "image", Source: &types.ImageSource{
					Type: "base64", MediaType: "image/png", Data: bigPayload,
				}},
			}},
		},
	}

	// nil provider forces the local-fallback path under test.
	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var convRow *BreakdownCategory
	for i := range bd.Categories {
		if bd.Categories[i].Kind == "conversation" {
			convRow = &bd.Categories[i]
		}
	}
	if convRow == nil {
		t.Fatal("expected a conversation row")
	}

	// The payload must contribute the fixed per-image cost, not its length.
	// A generous ceiling keeps this from being brittle about the small
	// surrounding text and block metadata while still failing hard on any
	// byte-length counting.
	const ceiling = types.ImageBlockTokenEstimate + 2000
	if convRow.Tokens > ceiling {
		t.Errorf("conversation tokens = %d, want <= %d — the image's base64 payload is being counted by byte length",
			convRow.Tokens, ceiling)
	}
	// The image is still counted; it is not silently dropped.
	if convRow.Tokens < types.ImageBlockTokenEstimate {
		t.Errorf("conversation tokens = %d, want >= %d (the fixed per-image estimate)",
			convRow.Tokens, types.ImageBlockTokenEstimate)
	}

	// Precondition: byte-length counting really would be catastrophic here, so
	// a future regression cannot pass this test by coincidence.
	naive, _, _ := LocalTokenCount("gpt-4o", bigPayload)
	if naive <= ceiling {
		t.Fatalf("test precondition failed: naive payload count %d is not above the ceiling %d", naive, ceiling)
	}
}

// TestBuildContextBreakdown_ImageBytesNotCountedAsText_DiskShape is the same
// assertion for the []any-of-map[string]any shape content takes after a JSON
// round-trip through disk — which is exactly the shape the on-demand breakdown
// sees, because it loads the conversation from .llm.jsonl.
func TestBuildContextBreakdown_ImageBytesNotCountedAsText_DiskShape(t *testing.T) {
	resetBreakdownCache()

	bigPayload := strings.Repeat("B", 60_000)

	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Messages: []types.LlmMessage{
			{Role: "user", Content: []any{
				map[string]any{"type": "text", "text": "describe this screenshot"},
				map[string]any{"type": "image", "source": map[string]any{
					"type": "base64", "media_type": "image/png", "data": bigPayload,
				}},
			}},
		},
	}

	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var convRow *BreakdownCategory
	for i := range bd.Categories {
		if bd.Categories[i].Kind == "conversation" {
			convRow = &bd.Categories[i]
		}
	}
	if convRow == nil {
		t.Fatal("expected a conversation row")
	}

	const ceiling = types.ImageBlockTokenEstimate + 2000
	if convRow.Tokens > ceiling {
		t.Errorf("disk-shape conversation tokens = %d, want <= %d — base64 counted by byte length",
			convRow.Tokens, ceiling)
	}
	if convRow.Tokens < types.ImageBlockTokenEstimate {
		t.Errorf("disk-shape conversation tokens = %d, want >= %d (fixed per-image estimate)",
			convRow.Tokens, types.ImageBlockTokenEstimate)
	}
}

// TestBuildContextBreakdown_ImageEstimateMatchesCompaction pins that the
// breakdown itemizer and the compaction numerator charge an image the same
// amount. These are two independent estimators in packages that cannot import
// each other; they agree only because both read
// types.ImageBlockTokenEstimate. A divergence here means a conversation would
// be reported at one size and compacted against another.
func TestBuildContextBreakdown_ImageEstimateMatchesCompaction(t *testing.T) {
	resetBreakdownCache()

	// Two images, so the assertion pins per-image scaling rather than a
	// coincidentally-correct single-image constant.
	payload := strings.Repeat("C", 60_000)
	opts := &types.LlmStreamOptions{
		Model: "gpt-4o",
		Messages: []types.LlmMessage{
			{Role: "user", Content: []types.LlmContentBlock{
				{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: payload}},
				{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: payload}},
			}},
		},
	}

	bd, err := BuildContextBreakdown(context.Background(), "gpt-4o", nil, opts, nil, nil, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var convRow *BreakdownCategory
	for i := range bd.Categories {
		if bd.Categories[i].Kind == "conversation" {
			convRow = &bd.Categories[i]
		}
	}
	if convRow == nil {
		t.Fatal("expected a conversation row")
	}

	wantFloor := 2 * types.ImageBlockTokenEstimate
	if convRow.Tokens < wantFloor {
		t.Errorf("two-image conversation tokens = %d, want >= %d (%d per image)",
			convRow.Tokens, wantFloor, types.ImageBlockTokenEstimate)
	}
	if convRow.Tokens > wantFloor+2000 {
		t.Errorf("two-image conversation tokens = %d, want ~%d — payload bytes are leaking into the count",
			convRow.Tokens, wantFloor)
	}
}

func TestBuildContextBreakdown_Cache(t *testing.T) {
	resetBreakdownCache()
	// System / file / memory / extension rows resolve through the content-hash
	// cache (countText). Conversation and tools are counted structurally on
	// every build (they bypass the cache by design), so this test exercises a
	// cached category only: identical system content must not re-call the
	// provider on the second build.
	opts := &types.LlmStreamOptions{
		Model:  "gpt-4o",
		System: "identical system prompt",
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
	ReconcileBreakdown(bd, 223, 0, 0) // itemized 100 + 123 drift

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
	// A 200-token drift on a 1200-token prompt is > 5% and > the 50-token
	// floor, so it MUST surface as an explicit unaccounted row — never folded
	// into an existing category.
	bd := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 1000, Tier: TierLocal}},
		TotalTokens: 1000,
		Model:       "gpt-4o",
	}
	before := len(bd.Categories)
	ReconcileBreakdown(bd, 1200, 0, 0) // drift = 200

	if len(bd.Categories) != before+1 {
		t.Fatalf("expected exactly one appended row, got %d new", len(bd.Categories)-before)
	}
	// The original system row must be untouched.
	if bd.Categories[0].Tokens != 1000 {
		t.Fatalf("system row mutated: tokens = %d, want 1000", bd.Categories[0].Tokens)
	}
	last := bd.Categories[len(bd.Categories)-1]
	if last.Kind != "unaccounted" || last.Tokens != 200 {
		t.Fatalf("drift not surfaced as unaccounted row: got kind=%q tokens=%d", last.Kind, last.Tokens)
	}
}

func TestReconcileBreakdown_UnaccountedBound(t *testing.T) {
	// Sub-threshold drift: 10 tokens on a large prompt is < the 50-token floor
	// AND < 5%, so NO unaccounted row is appended — but the honest Unaccounted
	// field is still set.
	small := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 2000, Tier: TierLocal}},
		TotalTokens: 2000,
		Model:       "gpt-4o",
	}
	before := len(small.Categories)
	ReconcileBreakdown(small, 2010, 0, 0) // drift = 10
	if len(small.Categories) != before {
		t.Fatalf("sub-threshold drift must NOT append a row; got %d new", len(small.Categories)-before)
	}
	if small.Unaccounted != 10 {
		t.Fatalf("Unaccounted field must stay honest: got %d, want 10", small.Unaccounted)
	}

	// Above-threshold drift: 200 tokens > both the 50-token floor and 5% of the
	// reported total (2200 * 5% = 110), so a row IS appended with the value.
	big := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 2000, Tier: TierLocal}},
		TotalTokens: 2000,
		Model:       "gpt-4o",
	}
	before = len(big.Categories)
	ReconcileBreakdown(big, 2200, 0, 0) // drift = 200
	if len(big.Categories) != before+1 {
		t.Fatalf("above-threshold drift must append exactly one row; got %d new", len(big.Categories)-before)
	}
	last := big.Categories[len(big.Categories)-1]
	if last.Kind != "unaccounted" || last.Tokens != 200 {
		t.Fatalf("unaccounted row wrong: kind=%q tokens=%d, want unaccounted/200", last.Kind, last.Tokens)
	}
}

func TestReconcileBreakdown_CacheAnnotation(t *testing.T) {
	bd := &ContextBreakdown{
		Categories:  []BreakdownCategory{{Name: "system", Kind: "system", Tokens: 500, Tier: TierLocal}},
		TotalTokens: 500,
		Model:       "gpt-4o",
	}
	ReconcileBreakdown(bd, 500, 1200, 300) // no drift, but cache annotations set

	if bd.CacheReadTokens != 1200 {
		t.Fatalf("CacheReadTokens = %d, want 1200", bd.CacheReadTokens)
	}
	if bd.CacheCreationTokens != 300 {
		t.Fatalf("CacheCreationTokens = %d, want 300", bd.CacheCreationTokens)
	}
	// Cache annotations must NOT be summed into TotalTokens.
	if bd.TotalTokens != 500 {
		t.Fatalf("cache tokens leaked into TotalTokens: got %d, want 500", bd.TotalTokens)
	}
	// Annotations must round-trip to the wire event.
	ev := bd.ToNormalizedEvent()
	if ev.CacheReadTokens != 1200 || ev.CacheCreationTokens != 300 {
		t.Fatalf("cache annotations not carried to event: read=%d create=%d", ev.CacheReadTokens, ev.CacheCreationTokens)
	}
}
