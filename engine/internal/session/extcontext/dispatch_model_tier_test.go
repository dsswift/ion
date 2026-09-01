package extcontext

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeDispatchTierConfig writes a models.json into an isolated HOME so tier
// lookups resolve without reading the operator's real ~/.ion/models.json.
func writeDispatchTierConfig(t *testing.T, tiers map[string]any) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("create test .ion dir: %v", err)
	}
	body, err := json.Marshal(map[string]any{"tiers": tiers})
	if err != nil {
		t.Fatalf("marshal tier config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), body, 0o600); err != nil {
		t.Fatalf("write tier config: %v", err)
	}
}

// The regression this pins: the shared dispatch seam had no tier resolution, so
// a caller that built DispatchAgentOpts directly (the Poll driver, an
// extension's ctx.dispatchAgent) sent the literal string "fast" to the provider
// as a model ID. Removing the resolveDispatchModelTier call turns this red.
func TestResolveDispatchModelTierResolvesConfiguredTier(t *testing.T) {
	writeDispatchTierConfig(t, map[string]any{"fast": "fast-model"})

	model, fallbacks := resolveDispatchModelTier("fast", nil)

	if model != "fast-model" {
		t.Fatalf("model = %q, want the tier's resolved model %q", model, "fast-model")
	}
	if len(fallbacks) != 0 {
		t.Fatalf("fallbacks = %v, want none for a tier with no chain", fallbacks)
	}
}

// A tier's own fallback chain reaches the child run, so an overloaded primary
// walks the operator's configured alternatives.
func TestResolveDispatchModelTierCarriesTierFallbacks(t *testing.T) {
	writeDispatchTierConfig(t, map[string]any{
		"fast": map[string]any{"model": "fast-model", "fallbacks": []string{"backup-model"}},
	})

	model, fallbacks := resolveDispatchModelTier("fast", nil)

	if model != "fast-model" {
		t.Fatalf("model = %q, want %q", model, "fast-model")
	}
	if len(fallbacks) != 1 || fallbacks[0] != "backup-model" {
		t.Fatalf("fallbacks = %v, want [backup-model]", fallbacks)
	}
}

// Idempotence: a concrete model ID is not a configured tier name, so it passes
// through untouched. This is what keeps callers that already resolved their own
// tier (the Agent tool via prompt_agent_spawner) unaffected.
func TestResolveDispatchModelTierPassesThroughConcreteModel(t *testing.T) {
	writeDispatchTierConfig(t, map[string]any{"fast": "fast-model"})

	model, fallbacks := resolveDispatchModelTier("some-provider/some-model", nil)

	if model != "some-provider/some-model" {
		t.Fatalf("model = %q, want the request unchanged", model)
	}
	if len(fallbacks) != 0 {
		t.Fatalf("fallbacks = %v, want none", fallbacks)
	}
}

// An empty request stays empty so the seam's own DefaultModel fallback applies.
func TestResolveDispatchModelTierLeavesEmptyRequestEmpty(t *testing.T) {
	writeDispatchTierConfig(t, map[string]any{"fast": "fast-model"})

	if model, _ := resolveDispatchModelTier("", nil); model != "" {
		t.Fatalf("model = %q, want empty so DefaultModel applies", model)
	}
}

// A caller-supplied chain is authoritative: a resolved tier never overwrites it.
func TestResolveDispatchModelTierKeepsCallerFallbacks(t *testing.T) {
	writeDispatchTierConfig(t, map[string]any{
		"fast": map[string]any{"model": "fast-model", "fallbacks": []string{"tier-backup"}},
	})

	_, fallbacks := resolveDispatchModelTier("fast", []string{"caller-backup"})

	if len(fallbacks) != 1 || fallbacks[0] != "caller-backup" {
		t.Fatalf("fallbacks = %v, want the caller's [caller-backup]", fallbacks)
	}
}
