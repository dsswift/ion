package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestResolveModelTier_PopulatesFallbackChain: when the tier value in
// models.json is an object with fallbacks, the resolved RunOptions carries
// the full chain so the retry loop can walk it on overload.
func TestResolveModelTier_PopulatesFallbackChain(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", dir)

	cfg := map[string]any{
		"tiers": map[string]any{
			"chiefs": map[string]any{
				"model":     "claude-opus-4-7",
				"fallbacks": []any{"claude-opus-4-6", "claude-sonnet-4-6"},
			},
		},
	}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	opts := &types.RunOptions{Model: "chiefs"}
	resolveModelTier(opts)

	if opts.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q, want claude-opus-4-7", opts.Model)
	}
	want := []string{"claude-opus-4-6", "claude-sonnet-4-6"}
	if len(opts.FallbackChain) != len(want) {
		t.Fatalf("FallbackChain len = %d, want %d", len(opts.FallbackChain), len(want))
	}
	for i, m := range want {
		if opts.FallbackChain[i] != m {
			t.Errorf("FallbackChain[%d] = %q, want %q", i, opts.FallbackChain[i], m)
		}
	}
}

// TestResolveModelTier_BareStringTierLeavesChainEmpty: legacy bare-string tier
// values must continue to work and leave the chain empty (no surprise fallback).
func TestResolveModelTier_BareStringTierLeavesChainEmpty(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	t.Setenv("HOME", dir)

	cfg := map[string]any{
		"tiers": map[string]any{"fast": "claude-haiku-4-5"},
	}
	data, _ := json.Marshal(cfg)
	os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644)

	opts := &types.RunOptions{Model: "fast"}
	resolveModelTier(opts)

	if opts.Model != "claude-haiku-4-5" {
		t.Errorf("Model = %q, want claude-haiku-4-5", opts.Model)
	}
	if len(opts.FallbackChain) != 0 {
		t.Errorf("FallbackChain = %v, want empty for bare-string tier", opts.FallbackChain)
	}
}

// TestResolveModelTier_CallerProvidedChainNotOverwritten: if a caller already
// set RunOptions.FallbackChain (e.g. via SDK), tier resolution must not stomp it.
func TestResolveModelTier_CallerProvidedChainNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	t.Setenv("HOME", dir)

	cfg := map[string]any{
		"tiers": map[string]any{
			"chiefs": map[string]any{
				"model":     "claude-opus-4-7",
				"fallbacks": []any{"claude-opus-4-6"},
			},
		},
	}
	data, _ := json.Marshal(cfg)
	os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644)

	opts := &types.RunOptions{
		Model:         "chiefs",
		FallbackChain: []string{"gpt-5.2"},
	}
	resolveModelTier(opts)

	if len(opts.FallbackChain) != 1 || opts.FallbackChain[0] != "gpt-5.2" {
		t.Errorf("caller chain stomped: %v", opts.FallbackChain)
	}
}
