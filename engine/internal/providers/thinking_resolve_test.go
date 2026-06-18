package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// registerThinkingTestModels registers synthetic models covering every
// ThinkingMode. Called at the top of each thinking test rather than from init,
// because other tests in this package reset the model registry
// (provider.go ReloadModels), which would wipe init-registered entries.
func registerThinkingTestModels() {
	RegisterModel("test-adaptive", types.ModelInfo{ProviderID: "anthropic", ThinkingMode: "adaptive", ThinkingEfforts: []string{"low", "medium", "high"}})
	RegisterModel("test-budget", types.ModelInfo{ProviderID: "anthropic", ThinkingMode: "budget", ThinkingEfforts: []string{"low", "medium", "high"}})
	RegisterModel("test-reasoning", types.ModelInfo{ProviderID: "openai", ThinkingMode: "reasoning_effort", ThinkingEfforts: []string{"low", "high"}})
	RegisterModel("test-gemini", types.ModelInfo{ProviderID: "google", ThinkingMode: "gemini", ThinkingEfforts: []string{"low", "medium", "high"}})
	RegisterModel("test-nothink", types.ModelInfo{ProviderID: "openai"})
}

func TestResolveThinking(t *testing.T) {
	registerThinkingTestModels()
	cases := []struct {
		name       string
		model      string
		cfg        *types.ThinkingConfig
		wantMode   string
		wantEffort string
		wantBudget int
	}{
		{"nil config", "test-adaptive", nil, "none", "", 0},
		{"disabled", "test-adaptive", &types.ThinkingConfig{Enabled: false, Effort: "high"}, "none", "", 0},
		{"adaptive high", "test-adaptive", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "adaptive", "high", 0},
		{"adaptive low", "test-adaptive", &types.ThinkingConfig{Enabled: true, Effort: "low"}, "adaptive", "low", 0},
		{"reasoning high", "test-reasoning", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "reasoning_effort", "high", 0},
		{"budget from effort medium", "test-budget", &types.ThinkingConfig{Enabled: true, Effort: "medium"}, "budget", "", 10000},
		{"budget from effort low", "test-budget", &types.ThinkingConfig{Enabled: true, Effort: "low"}, "budget", "", 4000},
		{"budget from effort high", "test-budget", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "budget", "", 24000},
		{"budget explicit overrides effort", "test-budget", &types.ThinkingConfig{Enabled: true, Effort: "low", BudgetTokens: 15000}, "budget", "", 15000},
		{"gemini from effort high", "test-gemini", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "gemini", "", 24000},
		{"unsupported model", "test-nothink", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "none", "", 0},
		// Deliberate contract: an OpenAI-family model that is registered but
		// declares NO thinkingMode (the shape every runtime-discovered model
		// gets — see model_discovery.go, which registers
		// types.ModelInfo{ProviderID: providerID} with an empty ThinkingMode)
		// resolves to "none". The engine NEVER forces a reasoning_effort on an
		// undeclared model; the operator opts a model in by declaring
		// thinkingMode + thinkingEfforts in ~/.ion model config. This pins the
		// fix for the old behavior where openai.go unconditionally emitted
		// reasoning_effort:"high" for any thinking-enabled model.
		{"openai discovered model without thinkingMode → no directive", "test-nothink", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "none", "", 0},
		{"unknown model", "does-not-exist", &types.ThinkingConfig{Enabled: true, Effort: "high"}, "none", "", 0},
		{"effort not in allowed set", "test-reasoning", &types.ThinkingConfig{Enabled: true, Effort: "medium"}, "none", "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveThinking(c.model, c.cfg)
			if got.Mode != c.wantMode {
				t.Errorf("Mode: got %q want %q", got.Mode, c.wantMode)
			}
			if got.Effort != c.wantEffort {
				t.Errorf("Effort: got %q want %q", got.Effort, c.wantEffort)
			}
			if got.Budget != c.wantBudget {
				t.Errorf("Budget: got %d want %d", got.Budget, c.wantBudget)
			}
		})
	}
}
