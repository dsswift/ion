package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// ComputeAndEmitContextBreakdown tests
// ---------------------------------------------------------------------------
//
// Three scenarios per the plan:
//
//   1. Fresh (empty) conversation: emits breakdown; conversation category
//      is zero (no messages on disk yet).
//
//   2. Historical conversation: emits a breakdown whose conversation category
//      token count is non-zero (messages loaded from disk).
//
//   3. Unknown key: does not panic and emits no event.

func TestComputeAndEmitContextBreakdown_CancelledContextEmitsNothing(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{DefaultModel: "claude-opus-4-5"})
	ec := newEventCollector(mgr)
	if _, err := mgr.StartSession("cancelled", types.EngineConfig{ProfileID: "test", WorkingDirectory: t.TempDir()}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := mgr.ComputeAndEmitContextBreakdownContext(ctx, "cancelled"); err == nil {
		t.Fatal("expected canceled context error")
	}
	if got := ec.byType("engine_context_breakdown"); len(got) != 0 {
		t.Fatalf("canceled breakdown emitted %d events, want 0", len(got))
	}
}

// TestComputeAndEmitContextBreakdown_FreshSession checks that an empty
// conversation produces a non-nil breakdown with zero conversation tokens.
func TestComputeAndEmitContextBreakdown_FreshSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// Wire a runtime config with a default model so the breakdown can resolve
	// token counts via local BPE (no provider needed).
	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("fresh", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.ComputeAndEmitContextBreakdown("fresh")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}

	ev := breakdowns[len(breakdowns)-1].event
	bd := ev.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	// Fresh session: no conversation messages, so conversation tokens == 0.
	conversationTokens := 0
	for _, cat := range bd.Categories {
		if cat.Kind == "conversation" {
			conversationTokens += cat.Tokens
		}
	}
	if conversationTokens != 0 {
		t.Errorf("fresh session: expected 0 conversation tokens, got %d", conversationTokens)
	}
}

// TestComputeAndEmitContextBreakdown_HistoricalSession checks that a session
// with on-disk messages produces a breakdown with non-zero conversation tokens.
func TestComputeAndEmitContextBreakdown_HistoricalSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	// Write a conversation file with a user message.
	convDir := filepath.Join(os.Getenv("HOME"), ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sessionID := "test-hist-cbd-" + t.Name()
	conv := conversation.CreateConversation(sessionID, "You are a test assistant.", "claude-opus-4-5")
	conversation.AddUserMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Hello, what is the capital of France?"}})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(convDir, sessionID+".llm.jsonl"))
		_ = os.Remove(filepath.Join(convDir, sessionID+".tree.jsonl"))
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("hist", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Inject the conversationID directly (mirrors what load_session_history does).
	mgr.mu.Lock()
	if s, ok := mgr.sessions["hist"]; ok {
		s.conversationID = sessionID
	}
	mgr.mu.Unlock()

	mgr.ComputeAndEmitContextBreakdown("hist")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}

	ev := breakdowns[len(breakdowns)-1].event
	bd := ev.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	// Historical session: conversation messages loaded, so tokens > 0.
	conversationTokens := 0
	for _, cat := range bd.Categories {
		if cat.Kind == "conversation" {
			conversationTokens += cat.Tokens
		}
	}
	if conversationTokens == 0 {
		t.Error("historical session: expected non-zero conversation tokens, got 0")
	}
}

// ---------------------------------------------------------------------------
// Occupancy publication
// ---------------------------------------------------------------------------
//
// The breakdown carries three token quantities that are easy to confuse, so the
// engine publishes the occupancy figure explicitly rather than leaving every
// consumer to pick one and hope:
//
//	OccupancyTokens  — authoritative "how full is the context"
//	APIReportedTotal — the provider's raw last-turn input_tokens
//	TotalTokens      — the itemized per-category estimate
//
// Before this field existed, a consumer rendering occupancy from a breakdown had
// to choose between TotalTokens (over-reports; counts content not billed this
// turn) and APIReportedTotal (under-reports mid-turn; omits tool results not yet
// sent). Both drift from what engine_status reports, so the drawer and the
// status bar disagreed by construction.

// TestComputeAndEmitContextBreakdown_PublishesOccupancy pins that the emitted
// event carries the engine's occupancy figure and that it equals what
// GetContextUsage reports for the same conversation — the same value
// engine_status publishes as ContextTokens.
//
// Fails before the fix: OccupancyTokens is absent (0).
func TestComputeAndEmitContextBreakdown_PublishesOccupancy(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	convDir := filepath.Join(os.Getenv("HOME"), ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sessionID := "test-occupancy-cbd-" + t.Name()
	conv := conversation.CreateConversation(sessionID, "You are a test assistant.", "claude-opus-4-5")
	conversation.AddUserMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Hello, what is the capital of France?"}})
	usage := types.LlmUsage{
		InputTokens:              2,
		OutputTokens:             169,
		CacheReadInputTokens:     253804,
		CacheCreationInputTokens: 396,
	}
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Paris."}}, usage)
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(convDir, sessionID+".llm.jsonl"))  //nolint:errcheck // test cleanup
		_ = os.Remove(filepath.Join(convDir, sessionID+".tree.jsonl")) //nolint:errcheck // test cleanup
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("occupancy", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	if s, ok := mgr.sessions["occupancy"]; ok {
		s.conversationID = sessionID
	}
	mgr.mu.Unlock()

	mgr.ComputeAndEmitContextBreakdown("occupancy")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}
	bd := breakdowns[len(breakdowns)-1].event.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	// The occupancy figure must be present and must equal what the engine's own
	// occupancy accessor reports — the field exists so consumers do not have to
	// approximate it.
	reloaded, err := conversation.Load(sessionID, "")
	if err != nil {
		t.Fatalf("reload conversation: %v", err)
	}
	want := conversation.GetContextUsage(reloaded, bd.ContextWindow).Tokens
	if bd.OccupancyTokens != want {
		t.Errorf("OccupancyTokens = %d, want %d (must equal GetContextUsage, the engine_status figure)",
			bd.OccupancyTokens, want)
	}
	if bd.OccupancyTokens == 0 {
		t.Error("OccupancyTokens = 0; the engine has an occupancy figure for this conversation and must publish it")
	}

	// Occupancy is its own quantity: it must not silently alias the itemized sum.
	// (It legitimately EQUALS APIReportedTotal here, because no messages were
	// appended after the last assistant turn — that identity is asserted below.)
	if bd.OccupancyTokens == bd.TotalTokens {
		t.Errorf("OccupancyTokens (%d) == TotalTokens (%d); occupancy must not be the itemized estimate",
			bd.OccupancyTokens, bd.TotalTokens)
	}
	// With nothing appended since the last provider response, occupancy and the
	// provider's reported total agree. This pins that the engine is not adding
	// phantom tokens on the quiescent path.
	if bd.OccupancyTokens != bd.APIReportedTotal {
		t.Errorf("OccupancyTokens (%d) != APIReportedTotal (%d) with no messages appended since the last turn",
			bd.OccupancyTokens, bd.APIReportedTotal)
	}
}

// TestComputeAndEmitContextBreakdown_OccupancyExceedsApiTotalMidTurn pins the
// case that motivated a separate field: when messages have been appended since
// the last provider response (tool results from an in-flight turn), occupancy
// includes them and APIReportedTotal does not. A consumer using
// APIReportedTotal as an occupancy proxy under-reports here.
func TestComputeAndEmitContextBreakdown_OccupancyExceedsApiTotalMidTurn(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	convDir := filepath.Join(os.Getenv("HOME"), ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sessionID := "test-occupancy-midturn-" + t.Name()
	conv := conversation.CreateConversation(sessionID, "You are a test assistant.", "claude-opus-4-5")
	conversation.AddUserMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Read the file."}})
	apiUsage := types.LlmUsage{InputTokens: 50_000, OutputTokens: 100}
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Reading."}}, apiUsage)
	// A tool result the provider has not yet been shown: real context the next
	// request will carry, invisible to the last turn's reported usage.
	conversation.AddToolResults(conv, []conversation.ToolResultEntry{{
		ToolUseID: "t1",
		Content:   strings.Repeat("file contents that occupy real context. ", 500),
	}})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(convDir, sessionID+".llm.jsonl"))  //nolint:errcheck // test cleanup
		_ = os.Remove(filepath.Join(convDir, sessionID+".tree.jsonl")) //nolint:errcheck // test cleanup
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{ProfileID: "test", WorkingDirectory: t.TempDir()}
	if _, err := mgr.StartSession("occ-mid", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	if s, ok := mgr.sessions["occ-mid"]; ok {
		s.conversationID = sessionID
	}
	mgr.mu.Unlock()

	mgr.ComputeAndEmitContextBreakdown("occ-mid")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}
	bd := breakdowns[len(breakdowns)-1].event.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	if bd.APIReportedTotal != apiUsage.InputTokens {
		t.Fatalf("APIReportedTotal = %d, want %d (the last turn's reported usage)",
			bd.APIReportedTotal, apiUsage.InputTokens)
	}
	// This is the whole point of the separate field: occupancy counts the
	// appended tool result, the provider's last-turn figure cannot.
	if bd.OccupancyTokens <= bd.APIReportedTotal {
		t.Errorf("OccupancyTokens (%d) must exceed APIReportedTotal (%d) when messages were appended since the last provider response",
			bd.OccupancyTokens, bd.APIReportedTotal)
	}
}

// TestComputeAndEmitContextBreakdown_UnknownKey checks that a missing session
// key does not panic and emits no event.
func TestComputeAndEmitContextBreakdown_UnknownKey(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	// Should not panic; a Warn log fires internally.
	mgr.ComputeAndEmitContextBreakdown("no-such-key")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) != 0 {
		t.Errorf("expected no event for unknown key, got %d", len(breakdowns))
	}
}

// ---------------------------------------------------------------------------
// Reconciliation against provider-reported usage
// ---------------------------------------------------------------------------
//
// The itemized per-category sum is an independent estimate; the provider's
// input_tokens is truth. The on-demand path formerly emitted the estimate with
// APIReportedTotal == 0, so no consumer could tell the two apart — a 256K-token
// conversation reached clients itemized at 1.03M and was rendered as >100%
// context on a 1M-window model.

// TestComputeAndEmitContextBreakdown_ReconcilesAgainstPersistedUsage pins that
// a conversation whose last assistant message carries API-reported usage emits
// a breakdown reconciled against that figure: APIReportedTotal is the provider
// total (input + cache_read + cache_creation), and Unaccounted is exactly the
// delta from the itemized sum.
//
// Fails before the fix: APIReportedTotal is 0 and Unaccounted is 0.
func TestComputeAndEmitContextBreakdown_ReconcilesAgainstPersistedUsage(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	convDir := filepath.Join(os.Getenv("HOME"), ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sessionID := "test-reconcile-cbd-" + t.Name()
	conv := conversation.CreateConversation(sessionID, "You are a test assistant.", "claude-opus-4-5")
	conversation.AddUserMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Hello, what is the capital of France?"}})

	// The provider's own accounting. Deliberately far from any plausible
	// itemized count of this two-message conversation so the assertion cannot
	// pass by coincidence, and split across all three fields so the test pins
	// the full summation rather than just input_tokens.
	usage := types.LlmUsage{
		InputTokens:              2,
		OutputTokens:             169,
		CacheReadInputTokens:     253804,
		CacheCreationInputTokens: 396,
	}
	wantAPITotal := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Paris."}}, usage)
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(convDir, sessionID+".llm.jsonl"))  //nolint:errcheck // test cleanup
		_ = os.Remove(filepath.Join(convDir, sessionID+".tree.jsonl")) //nolint:errcheck // test cleanup
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("reconcile", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	if s, ok := mgr.sessions["reconcile"]; ok {
		s.conversationID = sessionID
	}
	mgr.mu.Unlock()

	mgr.ComputeAndEmitContextBreakdown("reconcile")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}
	bd := breakdowns[len(breakdowns)-1].event.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	if bd.APIReportedTotal != wantAPITotal {
		t.Errorf("APIReportedTotal = %d, want %d (provider input + cache_read + cache_creation)",
			bd.APIReportedTotal, wantAPITotal)
	}

	// Unaccounted is the honest delta between provider truth and the itemized
	// sum. The itemized rows plus the unaccounted row must reconstruct the
	// provider total exactly — that identity is what makes the drift visible
	// rather than silently absorbed.
	itemized := 0
	for _, cat := range bd.Categories {
		if cat.Kind == "unaccounted" {
			continue
		}
		itemized += cat.Tokens
	}
	if bd.Unaccounted != wantAPITotal-itemized {
		t.Errorf("Unaccounted = %d, want %d (api total %d - itemized %d)",
			bd.Unaccounted, wantAPITotal-itemized, wantAPITotal, itemized)
	}
	if itemized+bd.Unaccounted != wantAPITotal {
		t.Errorf("itemized (%d) + unaccounted (%d) = %d, want provider total %d",
			itemized, bd.Unaccounted, itemized+bd.Unaccounted, wantAPITotal)
	}

	// The cache annotations ride along so a consumer can explain the total.
	if bd.CacheReadTokens != usage.CacheReadInputTokens {
		t.Errorf("CacheReadTokens = %d, want %d", bd.CacheReadTokens, usage.CacheReadInputTokens)
	}
	if bd.CacheCreationTokens != usage.CacheCreationInputTokens {
		t.Errorf("CacheCreationTokens = %d, want %d", bd.CacheCreationTokens, usage.CacheCreationInputTokens)
	}
}

// TestComputeAndEmitContextBreakdown_NoUsageEmitsUnreconciled pins the other
// branch: a conversation with no API response yet has nothing to reconcile
// against, so the breakdown emits the itemized total with APIReportedTotal == 0
// and does NOT fabricate a delta. Leaving the field zero is the honest signal
// that no provider figure was available.
func TestComputeAndEmitContextBreakdown_NoUsageEmitsUnreconciled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	mgr.SetConfig(&types.EngineRuntimeConfig{
		DefaultModel: "claude-opus-4-5",
	})

	convDir := filepath.Join(os.Getenv("HOME"), ".ion", "conversations")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	sessionID := "test-noreconcile-cbd-" + t.Name()
	conv := conversation.CreateConversation(sessionID, "You are a test assistant.", "claude-opus-4-5")
	// User message only — no assistant turn, so no provider usage on disk.
	conversation.AddUserMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Hello, what is the capital of France?"}})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save conversation: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Remove(filepath.Join(convDir, sessionID+".llm.jsonl"))  //nolint:errcheck // test cleanup
		_ = os.Remove(filepath.Join(convDir, sessionID+".tree.jsonl")) //nolint:errcheck // test cleanup
	})

	ec := newEventCollector(mgr)

	cfg := types.EngineConfig{
		ProfileID:        "test",
		WorkingDirectory: t.TempDir(),
	}
	if _, err := mgr.StartSession("noreconcile", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	if s, ok := mgr.sessions["noreconcile"]; ok {
		s.conversationID = sessionID
	}
	mgr.mu.Unlock()

	mgr.ComputeAndEmitContextBreakdown("noreconcile")

	breakdowns := ec.byType("engine_context_breakdown")
	if len(breakdowns) == 0 {
		t.Fatal("expected engine_context_breakdown event, got none")
	}
	bd := breakdowns[len(breakdowns)-1].event.ContextBreakdown
	if bd == nil {
		t.Fatal("ContextBreakdown payload is nil")
	}

	if bd.APIReportedTotal != 0 {
		t.Errorf("APIReportedTotal = %d, want 0 (no provider usage on disk)", bd.APIReportedTotal)
	}
	if bd.Unaccounted != 0 {
		t.Errorf("Unaccounted = %d, want 0 (nothing to reconcile against)", bd.Unaccounted)
	}
	// The itemized total is still reported — the breakdown is useful without a
	// provider figure, it is just labelled as unreconciled.
	if bd.TotalTokens <= 0 {
		t.Errorf("TotalTokens = %d, want > 0 (itemized sum still emitted)", bd.TotalTokens)
	}
	for _, cat := range bd.Categories {
		if cat.Kind == "unaccounted" {
			t.Errorf("unexpected unaccounted row (%d tokens) with no provider total to reconcile against", cat.Tokens)
		}
	}
}
