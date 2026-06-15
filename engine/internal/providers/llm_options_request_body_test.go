package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// llm_options_request_body_test.go — pins how temperature and jsonMode
// (ResponseFormat) map into each provider's request body (#225).
//
// Contract being locked:
//   - temperature is forwarded by openai + anthropic when set (pointer
//     non-nil), including a deliberate 0.0, and omitted when unset.
//   - jsonMode (ResponseFormat="json_object") is ENFORCED on
//     OpenAI-compatible providers (response_format object) and NOT mapped on
//     Anthropic (advisory only — Anthropic has no request-level switch).

func floatPtr(v float64) *float64 { return &v }

func TestOpenAIBuildRequestBody_Temperature(t *testing.T) {
	p := &openaiProvider{}

	// Unset → no temperature key.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m"})
	if _, ok := body["temperature"]; ok {
		t.Error("temperature present when unset; want omitted (provider default)")
	}

	// Explicit 0.0 → forwarded (deterministic is meaningful).
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", Temperature: floatPtr(0)})
	if got, ok := body["temperature"].(float64); !ok || got != 0 {
		t.Errorf("temperature = %v (ok=%t), want 0", body["temperature"], ok)
	}

	// Explicit 0.2 → forwarded verbatim.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", Temperature: floatPtr(0.2)})
	if got, ok := body["temperature"].(float64); !ok || got != 0.2 {
		t.Errorf("temperature = %v (ok=%t), want 0.2", body["temperature"], ok)
	}
}

func TestOpenAIBuildRequestBody_JSONModeEnforced(t *testing.T) {
	p := &openaiProvider{}

	// No ResponseFormat → no response_format key.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m"})
	if _, ok := body["response_format"]; ok {
		t.Error("response_format present without ResponseFormat; want omitted")
	}

	// ResponseFormat=json_object → enforced response_format object.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", ResponseFormat: "json_object"})
	rf, ok := body["response_format"].(map[string]any)
	if !ok {
		t.Fatalf("response_format = %v, want map[string]any{type:json_object}", body["response_format"])
	}
	if rf["type"] != "json_object" {
		t.Errorf("response_format.type = %v, want json_object", rf["type"])
	}
}

func TestAnthropicBuildRequestBody_Temperature(t *testing.T) {
	p := &anthropicProvider{}

	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m"})
	if _, ok := body["temperature"]; ok {
		t.Error("temperature present when unset; want omitted")
	}

	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", Temperature: floatPtr(0.1)})
	if got, ok := body["temperature"].(float64); !ok || got != 0.1 {
		t.Errorf("temperature = %v (ok=%t), want 0.1", body["temperature"], ok)
	}
}

func TestAnthropicBuildRequestBody_JSONModeAdvisoryOnly(t *testing.T) {
	p := &anthropicProvider{}

	// Even with ResponseFormat set, Anthropic must NOT include a
	// response_format key — it has no request-level JSON switch, so jsonMode
	// stays advisory. This pins the deliberate per-provider asymmetry.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m", ResponseFormat: "json_object"})
	if _, ok := body["response_format"]; ok {
		t.Error("Anthropic body includes response_format; jsonMode must stay advisory (no native switch)")
	}
}
