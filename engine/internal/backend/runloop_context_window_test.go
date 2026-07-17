package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)
// TestResolveContextWindow pins Defect 3: a registry entry with
// ContextWindow == 0 must NOT overwrite the engine default with 0 (which would
// collapse compaction to a 0-token budget every turn). The > 0 guard lives at
// the resolution site so the clamped value flows into the compaction math, not
// only into GetContextUsage's internal clamp.
func TestResolveContextWindow(t *testing.T) {
	// Registry entry with a zero context window (a catalog gap).
	providers.RegisterModel("ctxwin-zero-model", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 0,
	})
	// Registry entry with a usable positive window.
	providers.RegisterModel("ctxwin-positive-model", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 128000,
	})
	// "ctxwin-unknown-model" is deliberately NOT registered.

	tests := []struct {
		name  string
		model string
		want  int
	}{
		{"zero-window registry entry falls back to default", "ctxwin-zero-model", conversation.DefaultContext},
		{"positive-window registry entry is used", "ctxwin-positive-model", 128000},
		{"unknown model falls back to default", "ctxwin-unknown-model", conversation.DefaultContext},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveContextWindow(tt.model)
			if got != tt.want {
				t.Errorf("resolveContextWindow(%q) = %d, want %d", tt.model, got, tt.want)
			}
		})
	}
}

// TestResolveContextWindow_SonnetAndOpus48 pins the catalog values updated by
// the models.json fix so a future accidental regression is caught immediately.
func TestResolveContextWindow_SonnetAndOpus48(t *testing.T) {
	// claude-sonnet-4-6 was updated from 200k to 1M in the catalog fix.
	// claude-opus-4-8 was added with 1M window.
	cases := []struct {
		model string
		want  int
	}{
		{"claude-sonnet-4-6", 1_000_000},
		{"claude-opus-4-8", 1_000_000},
		{"claude-opus-4-6", 1_000_000}, // already correct; guard against accidental revert
		{"claude-opus-4-7", 1_000_000}, // same
	}
	for _, tc := range cases {
		t.Run(tc.model, func(t *testing.T) {
			got := resolveContextWindow(tc.model)
			if got != tc.want {
				t.Errorf("resolveContextWindow(%q) = %d, want %d", tc.model, got, tc.want)
			}
		})
	}
}
