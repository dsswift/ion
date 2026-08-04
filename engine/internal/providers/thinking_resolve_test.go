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

// TestValidateThinkingBudget pins the FINDING 3 guard: a thinking budget that
// meets or exceeds the output window is an error (the model would have no
// headroom for text/tool output), while a budget with headroom, or an absent
// output cap, is fine.
func TestValidateThinkingBudget(t *testing.T) {
	cases := []struct {
		name      string
		budget    int
		maxTokens int
		wantErr   bool
	}{
		{"budget below max", 4000, 8192, false},
		{"budget equals max", 8192, 8192, true},
		{"budget above max", 12000, 8192, true},
		{"no max cap (0)", 24000, 0, false},
		{"negative max treated as no cap", 24000, -1, false},
		{"budget one below max", 8191, 8192, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := ValidateThinkingBudget(c.budget, c.maxTokens)
			if c.wantErr && err == nil {
				t.Errorf("ValidateThinkingBudget(%d, %d): want error, got nil", c.budget, c.maxTokens)
			}
			if !c.wantErr && err != nil {
				t.Errorf("ValidateThinkingBudget(%d, %d): want nil, got %v", c.budget, c.maxTokens, err)
			}
		})
	}
}

// TestEffortBudgetTokens_FullLadder pins the effort→budget mapping for every
// level the engine accepts, INCLUDING the extended rungs.
//
// The mapping matters only for the mechanisms that take a raw token budget
// (Anthropic legacy `budget`, Gemini `thinkingConfig`); the effort-passthrough
// mechanisms (adaptive, reasoning_effort) send the level verbatim. That split
// is exactly why a missing rung here is dangerous: a level absent from the
// switch falls through to the MEDIUM budget, so xhigh/max would behave
// correctly on an OpenAI model and silently under-reason on a Gemini or legacy
// Anthropic one — a discrepancy no consumer could observe.
//
// Revert proof: removing the xhigh or max case drops it to 10000 and fails.
func TestEffortBudgetTokens_FullLadder(t *testing.T) {
	cases := []struct {
		effort string
		want   int
	}{
		{"low", 4000},
		{"medium", 10000},
		{"high", 24000},
		{"xhigh", 48000},
		{"max", 64000},
	}
	for _, tc := range cases {
		if got := effortBudgetTokens(tc.effort); got != tc.want {
			t.Errorf("effortBudgetTokens(%q) = %d, want %d", tc.effort, got, tc.want)
		}
	}

	// The ladder must be strictly increasing: a higher effort that bought
	// fewer thinking tokens would be an outright inversion of the control.
	prev := 0
	for _, tc := range cases {
		got := effortBudgetTokens(tc.effort)
		if got <= prev {
			t.Errorf("ladder not strictly increasing at %q: %d follows %d", tc.effort, got, prev)
		}
		prev = got
	}

	// An unknown level falls back to medium rather than disabling thinking,
	// because the caller explicitly asked for reasoning.
	if got := effortBudgetTokens("bogus"); got != 10000 {
		t.Errorf("effortBudgetTokens(unknown) = %d, want the medium fallback 10000", got)
	}
}

// A model that advertises an extended level must resolve it through, and one
// that does not must still reject it — the engine never hardcodes which levels
// a model supports, it defers to ThinkingEfforts.
func TestResolveThinking_ExtendedLevelsFollowModelDeclaration(t *testing.T) {
	RegisterModel("test-extended", types.ModelInfo{
		ProviderID:      "openai",
		ThinkingMode:    "reasoning_effort",
		ThinkingEfforts: []string{"low", "medium", "high", "xhigh"},
	})
	RegisterModel("test-basic", types.ModelInfo{
		ProviderID:      "openai",
		ThinkingMode:    "reasoning_effort",
		ThinkingEfforts: []string{"low", "medium", "high"},
	})

	res := resolveThinking("test-extended", &types.ThinkingConfig{Enabled: true, Effort: "xhigh"})
	if res.Mode != "reasoning_effort" || res.Effort != "xhigh" {
		t.Errorf("advertised xhigh: got %+v, want reasoning_effort/xhigh", res)
	}

	// Not advertised → no directive, rather than sending a level the provider
	// would reject.
	res = resolveThinking("test-basic", &types.ThinkingConfig{Enabled: true, Effort: "xhigh"})
	if res.Mode != "none" {
		t.Errorf("unadvertised xhigh: got %+v, want none", res)
	}
}
