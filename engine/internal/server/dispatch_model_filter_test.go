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
		{"dci-marketing", "dci-marketing/claude-opus-4-8", "claude-opus-4-8"},
		{"dci-marketing", "claude-opus-4-8", "claude-opus-4-8"},
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
		{ID: "dci-marketing/claude-opus-4-8", ProviderID: "dci-marketing"},
		{ID: "gpt-5.6-sol", ProviderID: "dci-marketing"},
		{ID: "public-catalog-only", ProviderID: "dci-marketing"},
		{ID: "user-defined", ProviderID: "dci-marketing", IsCustom: true},
		{ID: "claude-opus-4-8", ProviderID: "anthropic"},
	}
	// The discovery cache is intentionally outside this unit's concern. The
	// predicate receives a gateway snapshot equivalent through this test seam.
	got := filterModelsAgainstDiscovery(models, map[string]map[string]bool{
		"dci-marketing": {"claude-opus-4-8": true, "gpt-5.6-sol": true},
	}, map[string]bool{"dci-marketing": true})
	want := []string{"dci-marketing/claude-opus-4-8", "gpt-5.6-sol", "user-defined", "claude-opus-4-8"}
	if len(got) != len(want) {
		t.Fatalf("filtered len = %d, want %d: %#v", len(got), len(want), got)
	}
	for i, model := range got {
		if model.ID != want[i] {
			t.Errorf("filtered[%d] = %q, want %q", i, model.ID, want[i])
		}
	}
}
