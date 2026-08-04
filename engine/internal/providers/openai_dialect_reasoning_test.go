package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// openai_dialect_reasoning_test.go — pins the gateway-misdeclaration guard in
// the chat-completions body builder.
//
// Background. An enterprise gateway self-describes each model in its /models
// payload, including a `dialect` (which wire protocol to speak) and a
// `thinkingMode`. A model advertised as BOTH dialect:"openai-chat" AND
// thinkingMode:"reasoning_effort" is self-contradictory: OpenAI's hosted
// chat-completions endpoint rejects reasoning_effort outright when function
// tools are present, naming /v1/responses as the alternative. Ion sends tools
// on essentially every turn, so such a model fails 100% of real turns.
//
// The guard drops reasoning_effort for exactly that declared combination —
// turning a hard 400 into a successful but less deeply-reasoned turn — and
// logs at WARN so the degradation is visible and the gateway gets fixed.
//
// The scoping is the important part, and it is what these tests exist to pin:
// stock OpenAI-compatible providers (xAI/grok, DeepSeek, Groq, Ollama, ...)
// reach this SAME client with no dialect declared. They implement the protocol
// without OpenAI's restriction and must keep their reasoning. A guard keyed on
// the transport, or on a per-model allowlist, would silently downgrade them —
// that is the regression these tests prevent.
func registerDialectReasoningModels() {
	// Gateway-declared, self-contradictory: chat dialect + reasoning_effort.
	RegisterModel("gw-chat-reasoning", types.ModelInfo{
		ProviderID:      "test-gateway",
		Dialect:         "openai-chat",
		ThinkingMode:    "reasoning_effort",
		ThinkingEfforts: []string{"low", "medium", "high"},
	})
	// Gateway-declared and correct: responses dialect. Never reaches this
	// client in production, but pinned here to prove the guard keys on the
	// declared dialect rather than on "is a gateway model".
	RegisterModel("gw-responses-reasoning", types.ModelInfo{
		ProviderID:      "test-gateway",
		Dialect:         "openai-responses",
		ThinkingMode:    "reasoning_effort",
		ThinkingEfforts: []string{"low", "medium", "high"},
	})
	// Stock OpenAI-compatible provider: NO dialect declared. This is the
	// grok / deepseek shape.
	RegisterModel("stock-reasoning", types.ModelInfo{
		ProviderID:      "xai",
		ThinkingMode:    "reasoning_effort",
		ThinkingEfforts: []string{"low", "high"},
	})
}

func toolsFixture() []types.LlmToolDef {
	return []types.LlmToolDef{{
		Name:        "ping",
		Description: "p",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
	}}
}

// The misdeclared combination, with tools: suppress rather than send a request
// the endpoint is guaranteed to reject.
func TestOpenAIBuildRequestBody_SuppressesReasoningForMisdeclaredChatDialect(t *testing.T) {
	registerDialectReasoningModels()
	p := &openaiProvider{id: "test-gateway"}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:    "gw-chat-reasoning",
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
		Tools:    toolsFixture(),
	})
	if v, present := body["reasoning_effort"]; present {
		t.Errorf("reasoning_effort = %v, want ABSENT — the endpoint rejects it alongside function tools", v)
	}
}

// Same model WITHOUT tools is serviceable (verified against the live gateway),
// so the directive must still be sent.
func TestOpenAIBuildRequestBody_KeepsReasoningForMisdeclaredChatDialectWithoutTools(t *testing.T) {
	registerDialectReasoningModels()
	p := &openaiProvider{id: "test-gateway"}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:    "gw-chat-reasoning",
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
	})
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want high — no tools means no restriction", body["reasoning_effort"])
	}
}

// THE regression guard. A stock compatible provider declares no dialect and
// must keep reasoning even with tools present. grok-3-mini, grok-3-mini-fast,
// and deepseek-reasoner all take this path.
func TestOpenAIBuildRequestBody_KeepsReasoningForStockCompatibleProvider(t *testing.T) {
	registerDialectReasoningModels()
	p := &openaiProvider{id: "xai"}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:    "stock-reasoning",
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
		Tools:    toolsFixture(),
	})
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want high — a provider that declares no dialect must not be suppressed", body["reasoning_effort"])
	}
}

// A correctly-declared responses model is not suppressed by this guard: the
// key is the declared dialect, not gateway membership.
func TestOpenAIBuildRequestBody_KeepsReasoningForResponsesDialect(t *testing.T) {
	registerDialectReasoningModels()
	p := &openaiProvider{id: "test-gateway"}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:    "gw-responses-reasoning",
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
		Tools:    toolsFixture(),
	})
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want high — responses-dialect models are unaffected", body["reasoning_effort"])
	}
}

// An unknown model (never registered) must not trip the guard: with no
// declaration there is no contradiction to act on.
func TestOpenAIBuildRequestBody_UnknownModelUnaffectedByGuard(t *testing.T) {
	registerDialectReasoningModels()
	p := &openaiProvider{id: "openai"}
	body := p.buildRequestBody(types.LlmStreamOptions{
		Model:    "totally-unregistered-model",
		Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
		Tools:    toolsFixture(),
	})
	// resolveThinking already returns Mode:"none" for an unknown model, so no
	// directive is emitted for that reason — the guard must not be what
	// decides, and must not panic on a nil ModelInfo.
	if v, present := body["reasoning_effort"]; present {
		t.Errorf("reasoning_effort = %v, want absent for an undeclared model", v)
	}
}
