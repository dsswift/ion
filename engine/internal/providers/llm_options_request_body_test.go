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

// TestOpenAIResponsesBuildRequestBody_JSONModeEnforced pins jsonMode on the
// Responses dialect. The Responses API carries the format under text.format
// (ResponseTextParam.format in the OpenAI OpenAPI spec), NOT the Chat
// Completions top-level response_format key — so the generic
// ResponseFormat="json_object" must still produce provider-enforced JSON when
// a model is served by a Responses-dialect gateway.
func TestOpenAIResponsesBuildRequestBody_JSONModeEnforced(t *testing.T) {
	p := &openaiResponsesProvider{}

	// No ResponseFormat → no text key at all.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m"})
	if _, ok := body["text"]; ok {
		t.Error("text present without ResponseFormat; want omitted")
	}
	// The Chat-shaped key must never appear on the Responses body.
	if _, ok := body["response_format"]; ok {
		t.Error("response_format present on a Responses body; wrong dialect shape")
	}

	// ResponseFormat=json_object → text.format.type == json_object.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", ResponseFormat: "json_object"})
	text, ok := body["text"].(map[string]any)
	if !ok {
		t.Fatalf("text = %v, want map[string]any{format:...}", body["text"])
	}
	format, ok := text["format"].(map[string]any)
	if !ok {
		t.Fatalf("text.format = %v, want map[string]any{type:json_object}", text["format"])
	}
	if format["type"] != "json_object" {
		t.Errorf("text.format.type = %v, want json_object", format["type"])
	}
	if _, ok := body["response_format"]; ok {
		t.Error("response_format present on a Responses body; wrong dialect shape")
	}
}

// TestOpenAIResponsesBuildRequestBody_Temperature mirrors the Chat client's
// temperature contract on the Responses dialect.
func TestOpenAIResponsesBuildRequestBody_Temperature(t *testing.T) {
	p := &openaiResponsesProvider{}

	body := p.buildRequestBody(types.LlmStreamOptions{Model: "m"})
	if _, ok := body["temperature"]; ok {
		t.Error("temperature present when unset; want omitted (provider default)")
	}
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", Temperature: floatPtr(0)})
	if got, ok := body["temperature"].(float64); !ok || got != 0 {
		t.Errorf("temperature = %v (ok=%t), want 0", body["temperature"], ok)
	}
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "m", Temperature: floatPtr(0.2)})
	if got, ok := body["temperature"].(float64); !ok || got != 0.2 {
		t.Errorf("temperature = %v (ok=%t), want 0.2", body["temperature"], ok)
	}
}

// TestOpenAIResponsesEnvKeyGatedByProviderID pins the credential boundary:
// OPENAI_API_KEY is OpenAI's own credential and must never be adopted as a
// gateway's key. Gateway inner clients are constructed with the gateway's ID.
func TestOpenAIResponsesEnvKeyGatedByProviderID(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-openai-env-key")

	// A gateway-identified client must NOT pick up the OpenAI env key.
	gw, ok := NewOpenAIResponsesProvider(&ProviderOptions{
		ID:      "dci-marketing",
		BaseURL: "https://ai.example.com",
	}).(*openaiResponsesProvider)
	if !ok {
		t.Fatal("expected *openaiResponsesProvider")
	}
	if gw.apiKey != "" {
		t.Errorf("gateway provider adopted OPENAI_API_KEY (%q); credential crossed provider boundary", gw.apiKey)
	}

	// The OpenAI-identified client still gets the env fallback.
	direct, ok := NewOpenAIResponsesProvider(&ProviderOptions{ID: "openai"}).(*openaiResponsesProvider)
	if !ok {
		t.Fatal("expected *openaiResponsesProvider")
	}
	if direct.apiKey != "sk-openai-env-key" {
		t.Errorf("openai provider apiKey = %q, want the OPENAI_API_KEY value", direct.apiKey)
	}

	// The default id (no opts) is the Responses-native OpenAI client.
	def, ok := NewOpenAIResponsesProvider(nil).(*openaiResponsesProvider)
	if !ok {
		t.Fatal("expected *openaiResponsesProvider")
	}
	if def.apiKey != "sk-openai-env-key" {
		t.Errorf("default provider apiKey = %q, want the OPENAI_API_KEY value", def.apiKey)
	}
}
