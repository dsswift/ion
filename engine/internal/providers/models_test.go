package providers

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestMergeModelInfo_CatalogContextWindowWins(t *testing.T) {
	catalog := types.ModelInfo{
		ProviderID:       "anthropic",
		ContextWindow:    1000000,
		CostPer1kInput:   0.015,
		CostPer1kOutput:  0.075,
		SupportsCaching:  true,
		SupportsThinking: true,
		SupportsImages:   true,
	}
	user := types.ModelInfo{
		ProviderID:       "anthropic",
		ContextWindow:    200000, // wrong, but user config says so
		CostPer1kInput:   0.015,
		CostPer1kOutput:  0.075,
		SupportsCaching:  true,
		SupportsThinking: true,
		SupportsImages:   true,
	}

	merged := MergeModelInfo(catalog, user)
	if merged.ContextWindow != 1000000 {
		t.Errorf("ContextWindow = %d, want 1000000 (catalog should win)", merged.ContextWindow)
	}
	if merged.ProviderID != "anthropic" {
		t.Errorf("ProviderID = %q, want anthropic", merged.ProviderID)
	}
}

func TestMergeModelInfo_UserCostsOverrideCatalog(t *testing.T) {
	catalog := types.ModelInfo{
		ProviderID:      "anthropic",
		ContextWindow:   200000,
		CostPer1kInput:  0.003,
		CostPer1kOutput: 0.015,
	}
	user := types.ModelInfo{
		ProviderID:      "anthropic",
		CostPer1kInput:  0.005, // user override
		CostPer1kOutput: 0.020, // user override
	}

	merged := MergeModelInfo(catalog, user)
	if merged.CostPer1kInput != 0.005 {
		t.Errorf("CostPer1kInput = %f, want 0.005 (user override)", merged.CostPer1kInput)
	}
	if merged.CostPer1kOutput != 0.020 {
		t.Errorf("CostPer1kOutput = %f, want 0.020 (user override)", merged.CostPer1kOutput)
	}
	if merged.ContextWindow != 200000 {
		t.Errorf("ContextWindow = %d, want 200000 (catalog preserved)", merged.ContextWindow)
	}
}

func TestMergeModelInfo_UserProviderOverrides(t *testing.T) {
	catalog := types.ModelInfo{
		ProviderID:    "anthropic",
		ContextWindow: 1000000,
	}
	user := types.ModelInfo{
		ProviderID: "bedrock", // user routes through bedrock
	}

	merged := MergeModelInfo(catalog, user)
	if merged.ProviderID != "bedrock" {
		t.Errorf("ProviderID = %q, want bedrock (user route override)", merged.ProviderID)
	}
	if merged.ContextWindow != 1000000 {
		t.Errorf("ContextWindow = %d, want 1000000 (catalog preserved)", merged.ContextWindow)
	}
}

func TestMergeModelInfo_CapabilitiesAreAdditive(t *testing.T) {
	catalog := types.ModelInfo{
		ProviderID:       "anthropic",
		SupportsCaching:  true,
		SupportsThinking: true,
	}
	// User config omits supportsThinking (false zero value)
	user := types.ModelInfo{
		ProviderID:      "anthropic",
		SupportsCaching: true,
		SupportsImages:  true, // adds capability
	}

	merged := MergeModelInfo(catalog, user)
	if !merged.SupportsCaching {
		t.Error("SupportsCaching should be true (both have it)")
	}
	if !merged.SupportsThinking {
		t.Error("SupportsThinking should be true (catalog has it, user omission doesn't remove it)")
	}
	if !merged.SupportsImages {
		t.Error("SupportsImages should be true (user adds it)")
	}
}

func TestModelCatalogJSON_AllModelsRegistered(t *testing.T) {
	// The init() function loads models.json via loadModelsFromJSON.
	// Verify all expected models are in the registry with correct data.
	expectedModels := []struct {
		id            string
		providerID    string
		contextWindow int
	}{
		{"claude-opus-4-6", "anthropic", 1000000},
		{"claude-opus-4-7", "anthropic", 1000000},
		{"claude-sonnet-4-6", "anthropic", 200000},
		{"claude-haiku-4-5-20251001", "anthropic", 200000},
		{"gpt-4.1", "openai", 1047576},
		{"gpt-4.1-mini", "openai", 1047576},
		{"o4-mini", "openai", 200000},
		{"o3", "openai", 200000},
		{"gemini-2.5-pro", "google", 1048576},
		{"gemini-2.5-flash", "google", 1048576},
		{"grok-3", "xai", 131072},
		{"deepseek-chat", "deepseek", 65536},
		{"deepseek-reasoner", "deepseek", 65536},
		{"llama-3.3-70b-versatile", "groq", 131072},
		{"mistral-large-latest", "mistral", 131072},
		{"llama-3.3-70b", "cerebras", 131072},
	}

	for _, exp := range expectedModels {
		info := GetModelInfo(exp.id)
		if info == nil {
			t.Errorf("model %q not found in registry", exp.id)
			continue
		}
		if info.ProviderID != exp.providerID {
			t.Errorf("model %q: providerID = %q, want %q", exp.id, info.ProviderID, exp.providerID)
		}
		if info.ContextWindow != exp.contextWindow {
			t.Errorf("model %q: contextWindow = %d, want %d", exp.id, info.ContextWindow, exp.contextWindow)
		}
		if info.CostPer1kInput <= 0 {
			t.Errorf("model %q: CostPer1kInput = %f, want > 0", exp.id, info.CostPer1kInput)
		}
		if info.CostPer1kOutput <= 0 {
			t.Errorf("model %q: CostPer1kOutput = %f, want > 0", exp.id, info.CostPer1kOutput)
		}
	}
}

func TestModelCatalogJSON_RoundTrip(t *testing.T) {
	// Parse the embedded JSON directly and verify it matches the runtime registry.
	var entries []catalogEntry
	if err := json.Unmarshal(modelCatalogJSON, &entries); err != nil {
		t.Fatalf("failed to parse models.json: %v", err)
	}

	if len(entries) == 0 {
		t.Fatal("models.json is empty")
	}

	for _, e := range entries {
		info := GetModelInfo(e.ID)
		if info == nil {
			t.Errorf("model %q from JSON not found in registry", e.ID)
			continue
		}
		if info.ContextWindow != e.ContextWindow {
			t.Errorf("model %q: registry contextWindow=%d, JSON contextWindow=%d", e.ID, info.ContextWindow, e.ContextWindow)
		}
		if info.ProviderID != e.ProviderID {
			t.Errorf("model %q: registry providerID=%q, JSON providerID=%q", e.ID, info.ProviderID, e.ProviderID)
		}
		if info.CostPer1kInput != e.CostPer1kInput {
			t.Errorf("model %q: registry costInput=%f, JSON costInput=%f", e.ID, info.CostPer1kInput, e.CostPer1kInput)
		}
		if info.CostPer1kOutput != e.CostPer1kOutput {
			t.Errorf("model %q: registry costOutput=%f, JSON costOutput=%f", e.ID, info.CostPer1kOutput, e.CostPer1kOutput)
		}
	}
}
