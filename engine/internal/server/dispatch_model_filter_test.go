package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestBareModelID(t *testing.T) {
	cases := []struct {
		provider string
		model    string
		want     string
	}{
		{"corp-gateway", "corp-gateway/claude-opus-4-8", "claude-opus-4-8"},
		{"corp-gateway", "claude-opus-4-8", "claude-opus-4-8"},
		{"openrouter", "deepseek/deepseek-chat", "deepseek/deepseek-chat"},
	}
	for _, tc := range cases {
		if got := bareModelID(tc.provider, tc.model); got != tc.want {
			t.Errorf("bareModelID(%q, %q) = %q, want %q", tc.provider, tc.model, got, tc.want)
		}
	}
}

func TestFilterCustomGatewayModels(t *testing.T) {
	models := []types.ModelEntry{
		{ID: "corp-gateway/claude-opus-4-8", ProviderID: "corp-gateway"},
		{ID: "gpt-5.6-sol", ProviderID: "corp-gateway"},
		{ID: "public-catalog-only", ProviderID: "corp-gateway"},
		{ID: "user-defined", ProviderID: "corp-gateway", IsCustom: true},
		{ID: "claude-opus-4-8", ProviderID: "anthropic"},
	}
	// The discovery cache is intentionally outside this unit's concern. The
	// predicate receives a gateway snapshot equivalent through this test seam.
	got := filterModelsAgainstDiscovery(models, map[string]map[string]bool{
		"corp-gateway": {"claude-opus-4-8": true, "gpt-5.6-sol": true},
	}, map[string]bool{"corp-gateway": true})
	want := []string{"corp-gateway/claude-opus-4-8", "gpt-5.6-sol", "user-defined", "claude-opus-4-8"}
	if len(got) != len(want) {
		t.Fatalf("filtered len = %d, want %d: %#v", len(got), len(want), got)
	}
	for i, model := range got {
		if model.ID != want[i] {
			t.Errorf("filtered[%d] = %q, want %q", i, model.ID, want[i])
		}
	}
}
