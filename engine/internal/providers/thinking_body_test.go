package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinking_body_test.go — pins how a resolved ThinkingConfig maps into each
// provider's request body. Uses the synthetic test-* models registered in
// thinking_resolve_test.go (init) to stay independent of the live catalog.
//
// Contract:
//   - Anthropic adaptive model → thinking{type:"adaptive",display:"summarized"}
//     + output_config{effort}.
//   - Anthropic budget model    → thinking{type:"enabled",budget_tokens}.
//   - Anthropic adaptive model with NO config → display-only directive
//     (self-engaged thinking made observable; no output_config).
//   - OpenAI reasoning model     → reasoning_effort=<level>.
//   - Gemini model               → generationConfig.thinkingConfig{...}.
//   - Disabled / unsupported non-adaptive → NO thinking directive at all.

func enabledEffort(e string) *types.ThinkingConfig {
	return &types.ThinkingConfig{Enabled: true, Effort: e}
}

func TestAnthropicBuildRequestBody_AdaptiveThinking(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-adaptive", Thinking: enabledEffort("high")})

	thinking, ok := body["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking directive missing; body=%v", body)
	}
	if thinking["type"] != "adaptive" {
		t.Errorf("thinking.type = %v, want adaptive", thinking["type"])
	}
	if thinking["display"] != "summarized" {
		t.Errorf("thinking.display = %v, want summarized", thinking["display"])
	}
	oc, ok := body["output_config"].(map[string]any)
	if !ok || oc["effort"] != "high" {
		t.Errorf("output_config.effort = %v, want high", body["output_config"])
	}
}

func TestAnthropicBuildRequestBody_BudgetThinking(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}
	// MaxTokens with headroom above the 24000 effort=high budget so the
	// FINDING 3 clamp (budget >= max_tokens) does not fire — this test pins the
	// effort→budget mapping (high → 24000), not the clamp. Without an explicit
	// MaxTokens the builder defaults the output window to 16384, which is BELOW
	// 24000 and would (correctly) clamp; see
	// TestAnthropicBuildRequestBody_BudgetClampedToMaxTokens for that path.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-budget", Thinking: enabledEffort("high"), MaxTokens: 32000})

	thinking, ok := body["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking directive missing; body=%v", body)
	}
	if thinking["type"] != "enabled" {
		t.Errorf("thinking.type = %v, want enabled", thinking["type"])
	}
	if thinking["budget_tokens"] != 24000 {
		t.Errorf("thinking.budget_tokens = %v, want 24000", thinking["budget_tokens"])
	}
}

// TestAnthropicBuildRequestBody_BudgetClampedToMaxTokens pins the FINDING 3
// guard at the provider seam: when the resolved thinking budget (24000 for
// effort=high) meets or exceeds the run's MaxTokens, the body-builder must
// clamp budget_tokens to MaxTokens-1 so the model retains output headroom,
// rather than emitting a budget that guarantees a max_tokens-only turn.
func TestAnthropicBuildRequestBody_BudgetClampedToMaxTokens(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}
	// MaxTokens 8192 < budget 24000 → clamp to 8191.
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:     "test-budget",
		Thinking:  enabledEffort("high"),
		MaxTokens: 8192,
	})

	thinking, ok := body["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking directive missing; body=%v", body)
	}
	if thinking["budget_tokens"] != 8191 {
		t.Errorf("thinking.budget_tokens = %v, want 8191 (clamped to MaxTokens-1)", thinking["budget_tokens"])
	}
}

// TestAnthropicBuildRequestBody_BudgetNotClampedWithHeadroom verifies the
// clamp does NOT fire when the budget has headroom below MaxTokens: the
// resolved budget passes through unchanged.
func TestAnthropicBuildRequestBody_BudgetNotClampedWithHeadroom(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}
	// MaxTokens 32000 > budget 24000 → no clamp.
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:     "test-budget",
		Thinking:  enabledEffort("high"),
		MaxTokens: 32000,
	})

	thinking, ok := body["thinking"].(map[string]any)
	if !ok {
		t.Fatalf("thinking directive missing; body=%v", body)
	}
	if thinking["budget_tokens"] != 24000 {
		t.Errorf("thinking.budget_tokens = %v, want 24000 (unchanged, headroom available)", thinking["budget_tokens"])
	}
}

// TestAnthropicBuildRequestBody_AdaptiveSelfEngagedDisplayOnly pins the
// self-engaged-thinking fix: an adaptive model with NO thinking config (the
// shape every "thinking off" consumer sends — RunOptions.Thinking nil) still
// receives a display-only adaptive directive so the reasoning the model
// performs on its own returns readable summary text instead of empty blocks
// (estTokens=0 / no deltas). Critically, NO output_config/effort is attached —
// reasoning depth stays fully self-regulated. Reverting the anthropic.go
// "none" branch turns this red.
func TestAnthropicBuildRequestBody_AdaptiveSelfEngagedDisplayOnly(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}

	for _, tc := range []struct {
		name string
		cfg  *types.ThinkingConfig
	}{
		{"nil config", nil},
		{"explicitly disabled", &types.ThinkingConfig{Enabled: false}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-adaptive", Thinking: tc.cfg})
			thinking, ok := body["thinking"].(map[string]any)
			if !ok {
				t.Fatalf("thinking directive missing for adaptive model; body=%v", body)
			}
			if thinking["type"] != "adaptive" {
				t.Errorf("thinking.type = %v, want adaptive", thinking["type"])
			}
			if thinking["display"] != "summarized" {
				t.Errorf("thinking.display = %v, want summarized", thinking["display"])
			}
			if _, ok := body["output_config"]; ok {
				t.Errorf("output_config present on self-engaged path; want omitted (no effort directive), got %v", body["output_config"])
			}
		})
	}
}

// TestAnthropicBuildRequestBody_ThinkingOmittedWhenDisabled pins that the
// display-only directive is scoped to ADAPTIVE models: a budget-mode model
// (or an undeclared model) with no thinking config gets NO directive at all —
// the legacy budget mechanism cannot be display-only, and undeclared models
// give the engine no basis to ask for reasoning.
func TestAnthropicBuildRequestBody_ThinkingOmittedWhenDisabled(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}

	for _, model := range []string{"test-budget", "test-nothink", "unknown-model"} {
		body := p.buildRequestBody(types.LlmStreamOptions{Model: model})
		if _, ok := body["thinking"]; ok {
			t.Errorf("model %s: thinking present when config nil; want omitted", model)
		}
	}
}

func TestOpenAIBuildRequestBody_ReasoningEffort(t *testing.T) {
	registerThinkingTestModels()
	p := &openaiProvider{}

	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-reasoning", Thinking: enabledEffort("high")})
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want high", body["reasoning_effort"])
	}

	// Disabled → omitted.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-reasoning"})
	if _, ok := body["reasoning_effort"]; ok {
		t.Error("reasoning_effort present when config nil; want omitted")
	}

	// Non-reasoning model → omitted even when enabled. test-nothink is a
	// ProviderID:"openai" model with NO declared thinkingMode — the exact shape
	// every runtime-discovered model gets (model_discovery.go registers
	// ModelInfo{ProviderID: providerID} with an empty ThinkingMode). This is the
	// regression guard for the old behavior where buildRequestBody set
	// body["reasoning_effort"]="high" unconditionally for any thinking-enabled
	// model: the engine must NOT force a reasoning_effort on an undeclared model.
	// Restoring the old `body["reasoning_effort"] = "high"` line turns this red.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-nothink", Thinking: enabledEffort("high")})
	if _, ok := body["reasoning_effort"]; ok {
		t.Error("reasoning_effort present for non-reasoning model; want omitted")
	}
}

func TestGoogleBuildRequestBody_ThinkingConfig(t *testing.T) {
	registerThinkingTestModels()
	p := &googleProvider{}

	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-gemini", Thinking: enabledEffort("high")})
	gc, ok := body["generationConfig"].(map[string]any)
	if !ok {
		t.Fatalf("generationConfig missing; body=%v", body)
	}
	tc, ok := gc["thinkingConfig"].(map[string]any)
	if !ok {
		t.Fatalf("thinkingConfig missing; generationConfig=%v", gc)
	}
	if tc["includeThoughts"] != true {
		t.Errorf("includeThoughts = %v, want true", tc["includeThoughts"])
	}
	if tc["thinkingBudget"] != 24000 {
		t.Errorf("thinkingBudget = %v, want 24000", tc["thinkingBudget"])
	}

	// Disabled → no thinkingConfig.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-gemini"})
	gc, _ = body["generationConfig"].(map[string]any)
	if _, ok := gc["thinkingConfig"]; ok {
		t.Error("thinkingConfig present when config nil; want omitted")
	}
}
