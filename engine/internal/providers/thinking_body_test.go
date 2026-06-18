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
//   - OpenAI reasoning model     → reasoning_effort=<level>.
//   - Gemini model               → generationConfig.thinkingConfig{...}.
//   - Disabled / unsupported     → NO thinking directive at all.

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
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-budget", Thinking: enabledEffort("high")})

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

func TestAnthropicBuildRequestBody_ThinkingOmittedWhenDisabled(t *testing.T) {
	registerThinkingTestModels()
	p := &anthropicProvider{}
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-adaptive"})
	if _, ok := body["thinking"]; ok {
		t.Error("thinking present when config nil; want omitted")
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
