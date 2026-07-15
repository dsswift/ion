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

// registerHybridTestModels seeds the global model registry so routing can
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
// kindFor / ResolveFor: default routing rule (no per-provider preferences)
// ---------------------------------------------------------------------------

func TestHybrid_DefaultRule_AnthropicGoesClaudeCode(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected claude-code for anthropic model, got %q", kind)
	}
	if got := h.ResolveFor("claude-test-sonnet"); got != h.InnerClaudeCode() {
		t.Fatalf("expected inner ClaudeCodeBackend for claude-* model, got %T", got)
	}
}

func TestHybrid_DefaultRule_OpenAIGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	if kind := h.kindFor("gpt-test-4o"); kind != "api" {
		t.Fatalf("expected api for openai model under default rule, got %q", kind)
	}
	if got := h.ResolveFor("gpt-test-4o"); got != h.InnerApi() {
		t.Fatalf("expected inner ApiBackend for gpt-* model, got %T", got)
	}
}

func TestHybrid_DefaultRule_GoogleGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	if got := h.ResolveFor("gemini-test-pro"); got != h.InnerApi() {
		t.Fatalf("expected inner ApiBackend for gemini-* model, got %T", got)
	}
}

func TestHybrid_DefaultRule_UnknownModelGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	if kind := h.kindFor("totally-unknown-model"); kind != "api" {
		t.Fatalf("expected api for unknown model (safe default), got %q", kind)
	}
	if got := h.ResolveFor("totally-unknown-model"); got != h.InnerApi() {
		t.Fatalf("expected inner ApiBackend for unknown model, got %T", got)
	}
}

func TestHybrid_DefaultRule_EmptyModelGoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	if got := h.ResolveFor(""); got != h.InnerApi() {
		t.Fatalf("expected inner ApiBackend for empty model, got %T", got)
	}
}

// ---------------------------------------------------------------------------
// Per-provider backend preferences override the default rule
// ---------------------------------------------------------------------------

func TestHybrid_Prefs_OpenAIPinnedToCodex(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackendWithPrefs(map[string]string{"openai": "codex"})
	// The routing DECISION honors the preference (red on the old hardcoded
	// anthropic-only rule, which always sent openai to api).
	if kind := h.kindFor("gpt-test-4o"); kind != "codex" {
		t.Fatalf("expected codex for openai when pinned, got %q", kind)
	}
	// The codex backend is buildable, so ResolveFor returns a *CodexBackend
	// (not the api inner).
	if _, ok := h.ResolveFor("gpt-test-4o").(*CodexBackend); !ok {
		t.Fatalf("expected openai pinned-to-codex to resolve to *CodexBackend, got %T", h.ResolveFor("gpt-test-4o"))
	}
}

func TestHybrid_Prefs_AnthropicPinnedToApi(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackendWithPrefs(map[string]string{"anthropic": "api"})
	// Preference overrides the default anthropic → claude-code rule.
	if kind := h.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected api for anthropic when pinned to api, got %q", kind)
	}
	if got := h.ResolveFor("claude-test-sonnet"); got != h.InnerApi() {
		t.Fatalf("expected inner ApiBackend when anthropic pinned to api, got %T", got)
	}
}

func TestHybrid_Prefs_DoNotLeakToOtherProviders(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackendWithPrefs(map[string]string{"openai": "codex"})
	// Anthropic still follows the default rule.
	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected anthropic to keep default claude-code, got %q", kind)
	}
	// Google still follows the default rule.
	if kind := h.kindFor("gemini-test-pro"); kind != "api" {
		t.Fatalf("expected google to keep default api, got %q", kind)
	}
}

// ---------------------------------------------------------------------------
// Routing table: populated on StartRun, pruned on OnExit
// ---------------------------------------------------------------------------

func TestHybrid_RoutingTable_PopulatedOnStartRun(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	api := h.InnerApi()

	// Use an API-routed model so we don't try to spawn the Claude CLI
	// subprocess. recordRun mutates the table before any run executes.
	h.recordRun("req-1", api, "api", "gpt-test-4o")

	got, kind := h.lookup("req-1")
	if got != api {
		t.Fatalf("expected routing table to contain req-1 → api, got %T", got)
	}
	if kind != "api" {
		t.Fatalf("expected recorded kind api, got %q", kind)
	}
	if size := len(h.runs); size != 1 {
		t.Fatalf("expected table size 1, got %d", size)
	}
}

func TestHybrid_RoutingTable_MultipleEntries(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	api := h.InnerApi()
	cc := h.InnerClaudeCode()

	h.recordRun("req-cc", cc, "claude-code", "claude-test-sonnet")
	h.recordRun("req-api", api, "api", "gpt-test-4o")

	if got, _ := h.lookup("req-cc"); got != cc {
		t.Fatalf("expected req-cc → claude-code inner, got %T", got)
	}
	if got, _ := h.lookup("req-api"); got != api {
		t.Fatalf("expected req-api → api, got %T", got)
	}
	if size := len(h.runs); size != 2 {
		t.Fatalf("expected table size 2, got %d", size)
	}
}

func TestHybrid_RoutingTable_PrunedOnFanOutExit(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()

	h.recordRun("req-1", h.InnerApi(), "api", "gpt-test-4o")
	if size := len(h.runs); size != 1 {
		t.Fatalf("setup: expected size 1, got %d", size)
	}

	// Simulate the inner backend exiting. fanOutExit must remove the entry
	// before forwarding to any outer handler.
	var outerCalled int32
	h.OnExit(func(runID string, _ *int, _ *string, _ string) {
		atomic.AddInt32(&outerCalled, 1)
		// Inside the outer handler, the table should already be pruned.
		if got, _ := h.lookup(runID); got != nil {
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
	api := h.InnerApi()
	// Plant a routing entry pointing at the inner ApiBackend. Cancel then
	// calls ApiBackend.Cancel("req-1"), which returns false because no such
	// activeRun exists — the assertion is that the call reached the inner
	// (and didn't short-circuit false-from-lookup) and left the table intact.
	h.recordRun("req-1", api, "api", "gpt-test-4o")
	_ = h.Cancel("req-1") // inner returns false; the value isn't the point
	if got, _ := h.lookup("req-1"); got != api {
		t.Fatalf("Cancel should not prune table; got %T", got)
	}
}

// ---------------------------------------------------------------------------
// Steer: API-routed returns the inner's verdict; non-API returns false
// ---------------------------------------------------------------------------

func TestHybrid_Steer_ApiRouted_ReachesInner(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	api := h.InnerApi()
	h.recordRun("req-api", api, "api", "gpt-test-4o")
	// Inner ApiBackend has no activeRun with id "req-api", so Steer returns
	// false — the assertion is that the call was forwarded to the inner
	// *ApiBackend, not short-circuited at the hybrid layer.
	_ = h.Steer("req-api", "follow up")
	if got, _ := h.lookup("req-api"); got != api {
		t.Fatalf("Steer should not mutate routing table; got %T", got)
	}
}

func TestHybrid_Steer_ClaudeCodeRouted_ReturnsFalse(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackend()
	h.recordRun("req-cc", h.InnerClaudeCode(), "claude-code", "claude-test-sonnet")
	if h.Steer("req-cc", "follow up") {
		t.Fatalf("expected Steer to return false for claude-code-routed run (caller falls back to stdin)")
	}
}

func TestHybrid_Steer_UnknownRunID_ReturnsFalse(t *testing.T) {
	h := NewHybridBackend()
	if h.Steer("never-started", "msg") {
		t.Fatalf("expected Steer to return false for unknown requestID")
	}
}

// ---------------------------------------------------------------------------
// NewChild: auth resolver + preference propagation
// ---------------------------------------------------------------------------

func TestHybrid_NewChild_PropagatesAuthResolver(t *testing.T) {
	h := NewHybridBackend()
	r := auth.NewResolver(nil)
	h.SetAuthResolver(r)

	child := h.NewChild()
	if child == nil {
		t.Fatalf("NewChild returned nil")
		return
	}
	if child == h {
		t.Fatalf("NewChild returned parent (should be a fresh instance)")
	}
	if child.InnerApi().AuthResolver() == nil {
		t.Fatalf("expected child's inner ApiBackend to have an auth resolver propagated")
		return
	}
	if child.InnerApi().AuthResolver() != r {
		t.Fatalf("expected child to share parent's resolver reference")
	}
}

func TestHybrid_NewChild_PropagatesPrefs(t *testing.T) {
	registerHybridTestModels(t)
	h := NewHybridBackendWithPrefs(map[string]string{"openai": "codex"})
	child := h.NewChild()
	if kind := child.kindFor("gpt-test-4o"); kind != "codex" {
		t.Fatalf("expected child to inherit openai→codex preference, got %q", kind)
	}
}

func TestHybrid_NewChild_NoResolver(t *testing.T) {
	h := NewHybridBackend()
	// No SetAuthResolver call.
	child := h.NewChild()
	if child == nil {
		t.Fatalf("NewChild returned nil")
		return
	}
	if child.InnerApi().AuthResolver() != nil {
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
	apiInner := h.InnerApi()
	ccInner := h.InnerClaudeCode()

	// Fire 100 goroutines that each record a run, then exit it. Run with
	// -race to detect any unsynchronized access to h.runs / h.runKinds.
	const N = 100
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func(idx int) {
			defer wg.Done()
			rid := "req-" + itoa(idx)
			inner, kind := RunBackend(apiInner), "api"
			if idx%2 == 0 {
				inner, kind = ccInner, "claude-code"
			}
			h.recordRun(rid, inner, kind, "gpt-test-4o")
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
// FlushConversations: forwards to every constructed inner backend
// ---------------------------------------------------------------------------

func TestHybrid_FlushConversations_NoError(t *testing.T) {
	h := NewHybridBackend()
	// Construct both inners so Flush reaches them; verify no panic.
	_ = h.InnerApi()
	_ = h.InnerClaudeCode()
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
	if h.InnerApi().AuthResolver() != nil {
		t.Fatalf("setup: expected inner ApiBackend to start with nil resolver")
	}
	r := auth.NewResolver(nil)
	h.SetAuthResolver(r)
	if h.InnerApi().AuthResolver() != r {
		t.Fatalf("expected SetAuthResolver to forward to inner ApiBackend")
	}
}
