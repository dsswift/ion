package backend

import (
	"sync"
	"testing"
)

// ---------------------------------------------------------------------------
// Fakes: key resolver + CLI-auth probe with live-flippable state
// ---------------------------------------------------------------------------

// fakeKeys is a KeyHaver whose per-provider answers can be flipped mid-test.
// Safe for concurrent use (the race test flips it while kindFor reads it).
type fakeKeys struct {
	mu   sync.Mutex
	keys map[string]bool
}

func newFakeKeys(providers ...string) *fakeKeys {
	f := &fakeKeys{keys: make(map[string]bool)}
	for _, p := range providers {
		f.keys[p] = true
	}
	return f
}

func (f *fakeKeys) HasKey(provider string) (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.keys[provider] {
		return true, "fake"
	}
	return false, ""
}

func (f *fakeKeys) set(provider string, has bool) {
	f.mu.Lock()
	f.keys[provider] = has
	f.mu.Unlock()
}

// fakeCliAuth returns a probe func over a flippable authed-kind set.
type fakeCliAuth struct {
	mu     sync.Mutex
	authed map[string]bool
}

func newFakeCliAuth(kinds ...string) *fakeCliAuth {
	f := &fakeCliAuth{authed: make(map[string]bool)}
	for _, k := range kinds {
		f.authed[k] = true
	}
	return f
}

func (f *fakeCliAuth) probe(kind string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.authed[kind]
}

func (f *fakeCliAuth) set(kind string, authed bool) {
	f.mu.Lock()
	f.authed[kind] = authed
	f.mu.Unlock()
}

// hybridWith builds a HybridBackend with the given fake credential seams
// injected. keys may be nil (no resolver wired); cli may be nil (no probe).
func hybridWith(keys KeyHaver, cli *fakeCliAuth, prefs map[string]string) *HybridBackend {
	h := NewHybridBackendWithPrefs(prefs)
	if keys != nil {
		h.mu.Lock()
		h.keys = keys
		h.mu.Unlock()
	}
	if cli != nil {
		h.SetCliAuthProbe(cli.probe)
	}
	return h
}

// ---------------------------------------------------------------------------
// Routing table: credential-based decision (api-key-wins → authed CLI → api)
// ---------------------------------------------------------------------------

func TestHybrid_Cred_ApiKeyWins_Anthropic(t *testing.T) {
	registerHybridTestModels(t)
	// Key present AND CLI authed: the key wins. RED on the old
	// anthropic → claude-code default.
	h := hybridWith(newFakeKeys("anthropic"), newFakeCliAuth("claude-code"), nil)
	if kind := h.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected api (api-key-wins), got %q", kind)
	}
}

func TestHybrid_Cred_ApiKeyWins_OpenAI(t *testing.T) {
	registerHybridTestModels(t)
	h := hybridWith(newFakeKeys("openai"), newFakeCliAuth("codex"), nil)
	if kind := h.kindFor("gpt-test-4o"); kind != "api" {
		t.Fatalf("expected api (api-key-wins), got %q", kind)
	}
}

func TestHybrid_Cred_NoKey_CliAuthed_Anthropic(t *testing.T) {
	registerHybridTestModels(t)
	h := hybridWith(newFakeKeys(), newFakeCliAuth("claude-code"), nil)
	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected claude-code (no key, CLI authed), got %q", kind)
	}
}

func TestHybrid_Cred_NoKey_CliAuthed_OpenAI(t *testing.T) {
	registerHybridTestModels(t)
	h := hybridWith(newFakeKeys(), newFakeCliAuth("codex"), nil)
	if kind := h.kindFor("gpt-test-4o"); kind != "codex" {
		t.Fatalf("expected codex (no key, CLI authed), got %q", kind)
	}
}

func TestHybrid_Cred_NoKey_CliNotAuthed_GoesApi(t *testing.T) {
	registerHybridTestModels(t)
	h := hybridWith(newFakeKeys(), newFakeCliAuth(), nil)
	if kind := h.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected api (no key, CLI not authed → clean provider error), got %q", kind)
	}
}

func TestHybrid_Cred_NoKey_NoCliCapability_GoesApi(t *testing.T) {
	registerHybridTestModels(t)
	// google has no delegated CLI kind at all.
	h := hybridWith(newFakeKeys(), newFakeCliAuth("claude-code", "codex"), nil)
	if kind := h.kindFor("gemini-test-pro"); kind != "api" {
		t.Fatalf("expected api for CLI-less provider, got %q", kind)
	}
}

func TestHybrid_Cred_NilProbe_FallsToApi(t *testing.T) {
	registerHybridTestModels(t)
	// cliAuthed never wired (Go-SDK consumer that never calls SetCliAuthProbe):
	// safe degrade to api, no panic.
	h := hybridWith(newFakeKeys(), nil, nil)
	if kind := h.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected api with nil probe, got %q", kind)
	}
}

func TestHybrid_Cred_ExplicitPrefStillWins(t *testing.T) {
	registerHybridTestModels(t)
	// Pref beats api-key-wins…
	h := hybridWith(newFakeKeys("anthropic"), newFakeCliAuth(), map[string]string{"anthropic": "claude-code"})
	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected explicit pref claude-code to beat api key, got %q", kind)
	}
	// …and pref to api beats an authed CLI.
	h2 := hybridWith(newFakeKeys(), newFakeCliAuth("claude-code"), map[string]string{"anthropic": "api"})
	if kind := h2.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected explicit pref api to beat authed CLI, got %q", kind)
	}
}

// ---------------------------------------------------------------------------
// EffectiveBackendForProvider: CLI-only provider degrade
// ---------------------------------------------------------------------------

func TestEffectiveBackend_CliOnlyProvider_StaysOnCli(t *testing.T) {
	// cursor cannot be served by the api backend; even unauthenticated it
	// routes to the cursor CLI so the error names the real problem.
	if kind := EffectiveBackendForProvider("cursor", newFakeKeys(), func(string) bool { return false }, ""); kind != "cursor" {
		t.Fatalf("expected cursor (CLI-only provider stays on CLI), got %q", kind)
	}
}

func TestEffectiveBackend_NilKeysNilProbe_Api(t *testing.T) {
	if kind := EffectiveBackendForProvider("anthropic", nil, nil, ""); kind != "api" {
		t.Fatalf("expected api with nil seams, got %q", kind)
	}
}

// ---------------------------------------------------------------------------
// Live flips: credential changes take effect on the next call, no rebuild
// ---------------------------------------------------------------------------

func TestHybrid_Cred_LiveChange_ApiKeyFlip(t *testing.T) {
	registerHybridTestModels(t)
	keys := newFakeKeys()
	cli := newFakeCliAuth("claude-code")
	h := hybridWith(keys, cli, nil)

	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("setup: expected claude-code before key, got %q", kind)
	}
	// Operator adds an API key: the very next routing decision flips to api
	// on the SAME instance — no reconstruction, no restart.
	keys.set("anthropic", true)
	if kind := h.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected api after key added, got %q", kind)
	}
	// Key removed again: falls back to the authed CLI.
	keys.set("anthropic", false)
	if kind := h.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected claude-code after key removed, got %q", kind)
	}
}

func TestHybrid_Cred_LiveChange_CliLoginFlip(t *testing.T) {
	registerHybridTestModels(t)
	keys := newFakeKeys()
	cli := newFakeCliAuth()
	h := hybridWith(keys, cli, nil)

	if kind := h.kindFor("gpt-test-4o"); kind != "api" {
		t.Fatalf("setup: expected api before codex login, got %q", kind)
	}
	// User completes `codex` login: next decision routes to codex, no rebuild.
	cli.set("codex", true)
	if kind := h.kindFor("gpt-test-4o"); kind != "codex" {
		t.Fatalf("expected codex after login, got %q", kind)
	}
	// Sign-out flips it back.
	cli.set("codex", false)
	if kind := h.kindFor("gpt-test-4o"); kind != "api" {
		t.Fatalf("expected api after logout, got %q", kind)
	}
}

// ---------------------------------------------------------------------------
// Concurrency: kindFor races credential flips (run with -race)
// ---------------------------------------------------------------------------

func TestHybrid_Cred_Concurrent_NoRace(t *testing.T) {
	registerHybridTestModels(t)
	keys := newFakeKeys()
	cli := newFakeCliAuth()
	h := hybridWith(keys, cli, nil)

	const N = 50
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < N; i++ {
			_ = h.kindFor("claude-test-sonnet")
			_ = h.kindFor("gpt-test-4o")
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < N; i++ {
			keys.set("anthropic", i%2 == 0)
			cli.set("codex", i%2 == 1)
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < N; i++ {
			// Re-wiring the probe mid-flight must also be race-free.
			h.SetCliAuthProbe(cli.probe)
		}
	}()
	wg.Wait()
}

// ---------------------------------------------------------------------------
// NewChild: probe propagation
// ---------------------------------------------------------------------------

func TestHybrid_NewChild_PropagatesCliAuthProbe(t *testing.T) {
	registerHybridTestModels(t)
	cli := newFakeCliAuth("claude-code")
	h := hybridWith(newFakeKeys(), cli, nil)

	child := h.NewChild()
	if kind := child.kindFor("claude-test-sonnet"); kind != "claude-code" {
		t.Fatalf("expected child to inherit cli-auth probe (claude-code), got %q", kind)
	}
	// The child shares the LIVE probe, not a snapshot: a flip is visible.
	cli.set("claude-code", false)
	if kind := child.kindFor("claude-test-sonnet"); kind != "api" {
		t.Fatalf("expected child to observe live probe flip (api), got %q", kind)
	}
}
