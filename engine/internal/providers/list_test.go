package providers

import (
	"testing"
)

func TestListModels(t *testing.T) {
	// ListModels should return all registered models sorted by provider then ID.
	models := ListModels()
	if len(models) == 0 {
		t.Fatal("expected at least one registered model")
	}

	// Should include known models from init()
	found := make(map[string]bool)
	for _, m := range models {
		found[m.ID] = true
	}

	expectedModels := []string{
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"gpt-4.1",
		"o4-mini",
	}
	for _, id := range expectedModels {
		if !found[id] {
			t.Errorf("expected model %q in ListModels output", id)
		}
	}

	// Verify sort order: should be sorted by provider then ID
	for i := 1; i < len(models); i++ {
		if models[i-1].ProviderID > models[i].ProviderID {
			t.Errorf("models not sorted by provider: %s > %s", models[i-1].ProviderID, models[i].ProviderID)
		}
		if models[i-1].ProviderID == models[i].ProviderID && models[i-1].ID > models[i].ID {
			t.Errorf("models not sorted by ID within provider %s: %s > %s", models[i].ProviderID, models[i-1].ID, models[i].ID)
		}
	}

	// Verify fields are populated
	for _, m := range models {
		if m.ProviderID == "" {
			t.Errorf("model %q has empty ProviderID", m.ID)
		}
		if m.ContextWindow <= 0 {
			t.Errorf("model %q has invalid ContextWindow: %d", m.ID, m.ContextWindow)
		}
	}
}

func TestListProviderIDs(t *testing.T) {
	// Ensure required providers exist (earlier tests may have removed init()-registered ones)
	ensureIDs := []string{"anthropic", "openai", "google", "groq", "ollama"}
	for _, id := range ensureIDs {
		if GetProvider(id) == nil {
			RegisterProvider(&mockProvider{id: id})
		}
	}

	ids := ListProviderIDs()
	if len(ids) == 0 {
		t.Fatal("expected at least one registered provider")
	}

	idSet := make(map[string]bool)
	for _, id := range ids {
		idSet[id] = true
	}

	for _, p := range ensureIDs {
		if !idSet[p] {
			t.Errorf("expected provider %q in ListProviderIDs output", p)
		}
	}

	// Verify sort order
	for i := 1; i < len(ids); i++ {
		if ids[i-1] > ids[i] {
			t.Errorf("provider IDs not sorted: %s > %s", ids[i-1], ids[i])
		}
	}
}
