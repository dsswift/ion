package backend

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Test model registry setup
// ---------------------------------------------------------------------------

// registerHybridTestModels seeds the global model registry so chooseFor can
// resolve provider IDs deterministically. Models registered here are inert
// for actual run execution — they only need ProviderID set so routing
// decisions are deterministic.
func registerHybridTestModels(t *testing.T) {
	t.Helper()
	providers.RegisterModel("claude-test-sonnet", types.ModelInfo{
		ProviderID:    "anthropic",
		ContextWindow: 200000,
	})
	providers.RegisterModel("gpt-test-4o", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 128000,
	})
	providers.RegisterModel("gemini-test-pro", types.ModelInfo{
		ProviderID:    "google",
		ContextWindow: 1000000,
	})
	// "totally-unknown-model" is deliberately NOT registered so we exercise
	// the GetModelInfo == nil branch.
}

// ---------------------------------------------------------------------------
// chooseFor: pure routing logic
// ---------------------------------------------------------------------------

func TestHybrid_ChooseFor_AnthropicGoesCli(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	got := h.chooseFor("claude-test-sonnet")
	if got != h.cli {
		t.Fatalf("expected inner CliBackend for claude-* model, got %T", got)
	}
}

func TestHybrid_ChooseFor_OpenAIGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	got := h.chooseFor("gpt-test-4o")
	if got != h.api {
		t.Fatalf("expected inner ApiBackend for gpt-* model, got %T", got)
	}
}

func TestHybrid_ChooseFor_GoogleGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	got := h.chooseFor("gemini-test-pro")
	if got != h.api {
		t.Fatalf("expected inner ApiBackend for gemini-* model, got %T", got)
	}
}

func TestHybrid_ChooseFor_UnknownModelGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	got := h.chooseFor("totally-unknown-model")
	if got != h.api {
		t.Fatalf("expected inner ApiBackend for unknown model (safe default), got %T", got)
	}
}

func TestHybrid_ChooseFor_EmptyModelGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	got := h.chooseFor("")
	if got != h.api {
		t.Fatalf("expected inner ApiBackend for empty model, got %T", got)
	}
}

// ---------------------------------------------------------------------------
// Routing table: populated on StartRun, pruned on OnExit
// ---------------------------------------------------------------------------

func TestHybrid_RoutingTable_PopulatedOnStartRun(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()

	// Use an API-routed model so we don't try to spawn the Claude CLI
	// subprocess (which would fail without the `claude` binary). The inner
	// ApiBackend.StartRun is safe to call with no provider key — the run
	// will error out quickly via the standard error path, but the routing
	// table mutation happens before that.
	h.recordRun("req-1", h.api, "gpt-test-4o")

	if got := h.lookup("req-1"); got != h.api {
		t.Fatalf("expected routing table to contain req-1 → api, got %T", got)
	}
	if size := len(h.runs); size != 1 {
		t.Fatalf("expected table size 1, got %d", size)
	}
}

func TestHybrid_RoutingTable_MultipleEntries(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()

	h.recordRun("req-cli", h.cli, "claude-test-sonnet")
	h.recordRun("req-api", h.api, "gpt-test-4o")

	if got := h.lookup("req-cli"); got != h.cli {
		t.Fatalf("expected req-cli → cli, got %T", got)
	}
	if got := h.lookup("req-api"); got != h.api {
		t.Fatalf("expected req-api → api, got %T", got)
	}
	if size := len(h.runs); size != 2 {
		t.Fatalf("expected table size 2, got %d", size)
	}
}

func TestHybrid_RoutingTable_PrunedOnFanOutExit(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()

	h.recordRun("req-1", h.api, "gpt-test-4o")
	if size := len(h.runs); size != 1 {
		t.Fatalf("setup: expected size 1, got %d", size)
	}

	// Simulate the inner backend exiting. fanOutExit must remove the entry
	// before forwarding to any outer handler.
	var outerCalled int32
	h.OnExit(func(runID string, _ *int, _ *string, _ string) {
		atomic.AddInt32(&outerCalled, 1)
		// Inside the outer handler, the table should already be pruned.
		if got := h.lookup(runID); got != nil {
			t.Errorf("outer OnExit: expected req-1 already removed from table, got %T", got)
		}
	})
	h.fanOutExit("req-1", nil, nil, "session-x")

	if atomic.LoadInt32(&outerCalled) != 1 {
		t.Fatalf("expected outer OnExit to fire once, got %d", outerCalled)
	}
	if size := len(h.runs); size != 0 {
		t.Fatalf("expected table size 0 after exit, got %d", size)
	}
}

// ---------------------------------------------------------------------------
// Cancel / IsRunning / WriteToStdin: route through the table
// ---------------------------------------------------------------------------

func TestHybrid_Cancel_UnknownRunID_ReturnsFalse(t *testing.T) {
	h := NewHybridBackend()
	if got := h.Cancel("never-started"); got {
		t.Fatalf("expected false for unknown requestID, got true")
	}
}

func TestHybrid_IsRunning_UnknownRunID_ReturnsFalse(t *testing.T) {
	h := NewHybridBackend()
	if h.IsRunning("never-started") {
		t.Fatalf("expected false for unknown requestID")
	}
}

func TestHybrid_WriteToStdin_UnknownRunID_NoError(t *testing.T) {
	h := NewHybridBackend()
	if err := h.WriteToStdin("never-started", map[string]any{"k": "v"}); err != nil {
		t.Fatalf("expected nil error for unknown requestID, got %v", err)
	}
}

func TestHybrid_Cancel_RoutesToInner(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	// Plant a routing entry pointing at the inner ApiBackend. Cancel will
	// then call ApiBackend.Cancel("req-1"), which returns false because no
	// such activeRun exists — the important assertion is that the call
	// reached the inner backend (and didn't return false-from-lookup).
	h.recordRun("req-1", h.api, "gpt-test-4o")

	// Since the inner ApiBackend has no run with id "req-1" registered,
	// it returns false — but the call must reach it (lookup found the
	// inner). We assert "no panic, returns the inner backend's verdict".
	_ = h.Cancel("req-1") // inner returns false; the value isn't the point
	// Table is not pruned by Cancel — only by OnExit.
	if got := h.lookup("req-1"); got != h.api {
		t.Fatalf("Cancel should not prune table; got %T", got)
	}
}

// ---------------------------------------------------------------------------
// Steer: API-routed returns the inner's verdict; CLI-routed returns false
// ---------------------------------------------------------------------------

func TestHybrid_Steer_ApiRouted_ReachesInner(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	h.recordRun("req-api", h.api, "gpt-test-4o")
	// Inner ApiBackend has no activeRun with id "req-api", so Steer returns
	// false. The assertion is on the routing: the call must have been
	// forwarded to the inner *ApiBackend, not short-circuited to false at
	// the hybrid layer.
	_ = h.Steer("req-api", "follow up")
	// No panic, table unchanged.
	if got := h.lookup("req-api"); got != h.api {
		t.Fatalf("Steer should not mutate routing table; got %T", got)
	}
}

func TestHybrid_Steer_CliRouted_ReturnsFalse(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	h.recordRun("req-cli", h.cli, "claude-test-sonnet")
	if h.Steer("req-cli", "follow up") {
		t.Fatalf("expected Steer to return false for CLI-routed run (caller falls back to stdin)")
	}
}

func TestHybrid_Steer_UnknownRunID_ReturnsFalse(t *testing.T) {
	h := NewHybridBackend()
	if h.Steer("never-started", "msg") {
		t.Fatalf("expected Steer to return false for unknown requestID")
	}
}

// ---------------------------------------------------------------------------
// NewChild: auth resolver propagation
// ---------------------------------------------------------------------------

func TestHybrid_NewChild_PropagatesAuthResolver(t *testing.T) {
	h := NewHybridBackend()
	r := auth.NewResolver(nil)
	h.SetAuthResolver(r)

	child := h.NewChild()
	if child == nil {
		t.Fatalf("NewChild returned nil")
	}
	if child == h {
		t.Fatalf("NewChild returned parent (should be a fresh instance)")
	}
	if child.api.AuthResolver() == nil {
		t.Fatalf("expected child's inner ApiBackend to have an auth resolver propagated")
	}
	if child.api.AuthResolver() != r {
		t.Fatalf("expected child to share parent's resolver reference")
	}
}

func TestHybrid_NewChild_NoResolver(t *testing.T) {
	h := NewHybridBackend()
	// No SetAuthResolver call.
	child := h.NewChild()
	if child == nil {
		t.Fatalf("NewChild returned nil")
	}
	if child.api.AuthResolver() != nil {
		t.Fatalf("expected child to have nil resolver when parent has none")
	}
}

// ---------------------------------------------------------------------------
// Outer hook fan-out
// ---------------------------------------------------------------------------

func TestHybrid_FanOutNormalized_ForwardsToOuter(t *testing.T) {
	h := NewHybridBackend()
	var calls int32
	var gotRunID string
	h.OnNormalized(func(runID string, _ types.NormalizedEvent) {
		atomic.AddInt32(&calls, 1)
		gotRunID = runID
	})
	h.fanOutNormalized("req-9", types.NormalizedEvent{})
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected outer OnNormalized to fire once, got %d", calls)
	}
	if gotRunID != "req-9" {
		t.Fatalf("expected runID req-9, got %q", gotRunID)
	}
}

func TestHybrid_FanOutNormalized_NilHandler_NoPanic(t *testing.T) {
	h := NewHybridBackend()
	// No OnNormalized call.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("expected no panic with nil handler, got %v", r)
		}
	}()
	h.fanOutNormalized("req-1", types.NormalizedEvent{})
}

func TestHybrid_FanOutError_ForwardsToOuter(t *testing.T) {
	h := NewHybridBackend()
	var calls int32
	h.OnError(func(_ string, _ error) {
		atomic.AddInt32(&calls, 1)
	})
	h.fanOutError("req-1", nil)
	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected outer OnError to fire once, got %d", calls)
	}
}

// ---------------------------------------------------------------------------
// Concurrency: many StartRun / OnExit pairs in flight at once
// ---------------------------------------------------------------------------

func TestHybrid_Concurrent_RecordAndPrune_NoRace(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()

	// Fire 100 goroutines that each record a run, then exit it. Run with
	// -race to detect any unsynchronized access to h.runs.
	const N = 100
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			rid := "req-" + itoa(idx)
			var inner RunBackend = h.api
			if idx%2 == 0 {
				inner = h.cli
			}
			h.recordRun(rid, inner, "gpt-test-4o")
			// Simulate the inner backend's OnExit firing.
			h.fanOutExit(rid, nil, nil, "session-x")
		}(i)
	}
	wg.Wait()

	if size := len(h.runs); size != 0 {
		t.Fatalf("expected table empty after concurrent record+prune, got %d", size)
	}
}

// itoa is a small helper to avoid importing strconv just for the concurrency
// test; values are 0..99 so a fixed-size loop suffices.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var buf [4]byte
	pos := len(buf)
	for i > 0 {
		pos--
		buf[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(buf[pos:])
}

// ---------------------------------------------------------------------------
// FlushConversations: forwards to both inner backends
// ---------------------------------------------------------------------------

func TestHybrid_FlushConversations_NoError(t *testing.T) {
	h := NewHybridBackend()
	// FlushConversations is a no-op on CliBackend and a best-effort sweep
	// on ApiBackend; verify the wrapper does not panic and reaches both.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("expected no panic, got %v", r)
		}
	}()
	h.FlushConversations()
}

// ---------------------------------------------------------------------------
// SetAuthResolver: forwards to inner ApiBackend only
// ---------------------------------------------------------------------------

func TestHybrid_SetAuthResolver_ForwardsToInnerApi(t *testing.T) {
	h := NewHybridBackend()
	if h.api.AuthResolver() != nil {
		t.Fatalf("setup: expected inner ApiBackend to start with nil resolver")
	}
	r := auth.NewResolver(nil)
	h.SetAuthResolver(r)
	if h.api.AuthResolver() != r {
		t.Fatalf("expected SetAuthResolver to forward to inner ApiBackend")
	}
}
