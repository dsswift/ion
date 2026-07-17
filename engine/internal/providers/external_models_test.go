package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestSetExternalModels_SurfacesInListAndDiscovered(t *testing.T) {
	ResetRegistries()
	t.Cleanup(func() { restoreInitRegistries(); SetCliBackedProviders(map[string]bool{}) })
	SetExternalModels("codextest", []types.ModelEntry{
		{ID: "gpt-5-codex-x", ProviderID: "codextest", ContextWindow: 256000},
		{ID: "gpt-5-mini-x", ProviderID: "codextest", ContextWindow: 128000},
	})

	disc := GetDiscoveredModels("codextest")
	if len(disc) != 2 {
		t.Fatalf("expected 2 discovered models, got %d", len(disc))
	}

	all := ListModels()
	found := 0
	for _, m := range all {
		if m.ID == "gpt-5-codex-x" || m.ID == "gpt-5-mini-x" {
			found++
		}
	}
	if found != 2 {
		t.Fatalf("expected both external models in ListModels, found %d", found)
	}
}

func TestRefreshModels_SkipsCliBackedProvider(t *testing.T) {
	ResetRegistries()
	t.Cleanup(func() { restoreInitRegistries(); SetCliBackedProviders(map[string]bool{}) })
	// Seed external (CLI-sourced) models, then mark the provider CLI-backed.
	SetExternalModels("xaicli", []types.ModelEntry{{ID: "grok-x", ProviderID: "xaicli", ContextWindow: 256000}})
	SetCliBackedProviders(map[string]bool{"xaicli": true})

	// A forced refresh must skip the HTTP fetch (which would clobber the
	// external models with a fallback/empty result) for a CLI-backed provider.
	RefreshModels("xaicli", true, func(string) (string, error) { return "key", nil }, nil)

	disc := GetDiscoveredModels("xaicli")
	if len(disc) != 1 || disc[0].ID != "grok-x" {
		t.Fatalf("expected external models preserved (HTTP skipped), got %+v", disc)
	}
}

func TestIsCliBacked(t *testing.T) {
	SetCliBackedProviders(map[string]bool{"openai": true})
	t.Cleanup(func() { SetCliBackedProviders(map[string]bool{}) })
	if !isCliBacked("openai") {
		t.Error("expected openai to be cli-backed")
	}
	if isCliBacked("anthropic") {
		t.Error("expected anthropic not cli-backed")
	}
}
