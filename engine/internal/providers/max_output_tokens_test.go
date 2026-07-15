package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// max_output_tokens_test.go — pins the per-model max-output-token resolution
// that replaced the hardcoded 16384 fallback in every provider body-builder.
//
// Contract (resolveMaxOutputTokens + per-provider wire shape):
//   - Explicit opts.MaxTokens wins verbatim on every provider.
//   - Else the model's registry MaxOutputTokens is used.
//   - Else (unknown model): OpenAI/Google OMIT the field entirely so the
//     provider applies the model's own maximum; Anthropic/Bedrock — whose APIs
//     require the field — substitute the conservative named constant.

// registerMaxOutTestModels registers synthetic models carrying a
// MaxOutputTokens value, one per native provider, so these tests stay
// independent of the live catalog.
func registerMaxOutTestModels() {
	RegisterModel("test-maxout-anthropic", types.ModelInfo{ProviderID: "anthropic", MaxOutputTokens: 64000})
	RegisterModel("test-maxout-openai", types.ModelInfo{ProviderID: "openai", MaxOutputTokens: 100000})
	RegisterModel("test-maxout-google", types.ModelInfo{ProviderID: "google", MaxOutputTokens: 65536})
	RegisterModel("test-maxout-bedrock", types.ModelInfo{ProviderID: "bedrock", MaxOutputTokens: 8192})
}

// --- resolveMaxOutputTokens (the shared helper) ---

func TestResolveMaxOutputTokens(t *testing.T) {
	registerMaxOutTestModels()

	// Explicit override wins over the registry value.
	if got, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "test-maxout-openai", MaxTokens: 4096}); !ok || got != 4096 {
		t.Errorf("explicit override: got (%d,%v), want (4096,true)", got, ok)
	}

	// Registry value used when no override.
	if got, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "test-maxout-openai"}); !ok || got != 100000 {
		t.Errorf("registry value: got (%d,%v), want (100000,true)", got, ok)
	}

	// Unknown model, no override → (0, false): "no engine opinion".
	if got, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "totally-unknown-model"}); ok || got != 0 {
		t.Errorf("unknown model: got (%d,%v), want (0,false)", got, ok)
	}

	// Unknown model WITH override → override still wins.
	if got, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "totally-unknown-model", MaxTokens: 2048}); !ok || got != 2048 {
		t.Errorf("unknown model with override: got (%d,%v), want (2048,true)", got, ok)
	}
}

// --- OpenAI: optional field, omit when unknown ---

func TestOpenAIBuildRequestBody_MaxTokens(t *testing.T) {
	registerMaxOutTestModels()
	p := &openaiProvider{}

	// Explicit override wins.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-openai", MaxTokens: 4096})
	if got := body["max_completion_tokens"]; got != 4096 {
		t.Errorf("override: max_completion_tokens = %v, want 4096", got)
	}

	// Registry value used when no override.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-openai"})
	if got := body["max_completion_tokens"]; got != 100000 {
		t.Errorf("registry: max_completion_tokens = %v, want 100000", got)
	}

	// Unknown model → key OMITTED (provider applies model's own maximum).
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "totally-unknown-model"})
	if _, ok := body["max_completion_tokens"]; ok {
		t.Errorf("unknown model: max_completion_tokens present (%v); want omitted", body["max_completion_tokens"])
	}
}

// --- Google: optional field, omit when unknown ---

func TestGoogleBuildRequestBody_MaxTokens(t *testing.T) {
	registerMaxOutTestModels()
	p := &googleProvider{}

	// Explicit override wins.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-google", MaxTokens: 4096})
	gc, _ := body["generationConfig"].(map[string]any)
	if got := gc["maxOutputTokens"]; got != 4096 {
		t.Errorf("override: maxOutputTokens = %v, want 4096", got)
	}

	// Registry value used when no override.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-google"})
	gc, _ = body["generationConfig"].(map[string]any)
	if got := gc["maxOutputTokens"]; got != 65536 {
		t.Errorf("registry: maxOutputTokens = %v, want 65536", got)
	}

	// Unknown model → key OMITTED but generationConfig still present.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "totally-unknown-model"})
	gc, ok := body["generationConfig"].(map[string]any)
	if !ok {
		t.Fatalf("generationConfig missing; body=%v", body)
	}
	if _, ok := gc["maxOutputTokens"]; ok {
		t.Errorf("unknown model: maxOutputTokens present (%v); want omitted", gc["maxOutputTokens"])
	}
}

// --- Anthropic: required field, named-const fallback when unknown ---

func TestAnthropicBuildRequestBody_MaxTokens(t *testing.T) {
	registerMaxOutTestModels()
	p := &anthropicProvider{}

	// Explicit override wins.
	body := p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-anthropic", MaxTokens: 4096})
	if got := body["max_tokens"]; got != 4096 {
		t.Errorf("override: max_tokens = %v, want 4096", got)
	}

	// Registry value used when no override.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "test-maxout-anthropic"})
	if got := body["max_tokens"]; got != 64000 {
		t.Errorf("registry: max_tokens = %v, want 64000", got)
	}

	// Unknown model → REQUIRED field falls back to the conservative constant.
	body = p.buildRequestBody(types.LlmStreamOptions{Model: "totally-unknown-model"})
	if got := body["max_tokens"]; got != anthropicDefaultMaxTokens {
		t.Errorf("unknown model: max_tokens = %v, want %d (const)", got, anthropicDefaultMaxTokens)
	}
}

// --- Bedrock: required field, named-const fallback when unknown ---
// Bedrock builds inferenceConfig inside doStream (not a separate builder), so
// this test asserts the resolution helper directly against the bedrock model,
// mirroring the value doStream places into inferenceConfig.maxTokens.

func TestBedrockMaxTokensResolution(t *testing.T) {
	registerMaxOutTestModels()

	// Registry value used when no override.
	if got, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "test-maxout-bedrock"}); !ok || got != 8192 {
		t.Errorf("registry: got (%d,%v), want (8192,true)", got, ok)
	}

	// Unknown model → helper returns false, so doStream substitutes the const.
	if _, ok := resolveMaxOutputTokens(types.LlmStreamOptions{Model: "totally-unknown-model"}); ok {
		t.Error("unknown model: resolveMaxOutputTokens returned ok=true; want false so bedrock uses the const")
	}
	if bedrockDefaultMaxTokens != 16384 {
		t.Errorf("bedrockDefaultMaxTokens = %d, want 16384", bedrockDefaultMaxTokens)
	}
}

// --- Registry load + wire projection ---

func TestCatalogModelCarriesMaxOutputTokens(t *testing.T) {
	// claude-opus-4-6 is a live catalog model seeded with 128000 in models.json.
	info := GetModelInfo("claude-opus-4-6")
	if info == nil {
		t.Fatal("claude-opus-4-6 not registered from catalog")
	}
	if info.MaxOutputTokens != 128000 {
		t.Errorf("claude-opus-4-6 MaxOutputTokens = %d, want 128000", info.MaxOutputTokens)
	}
}

func TestListModelsProjectsMaxOutputTokens(t *testing.T) {
	found := false
	for _, e := range ListModels() {
		if e.ID == "claude-opus-4-6" {
			found = true
			if e.MaxOutputTokens != 128000 {
				t.Errorf("ModelEntry claude-opus-4-6 MaxOutputTokens = %d, want 128000", e.MaxOutputTokens)
			}
		}
	}
	if !found {
		t.Skip("claude-opus-4-6 not in ListModels output (discovery may have replaced the catalog); skipping wire projection assertion")
	}
}

func TestMergeModelInfoCarriesMaxOutputTokens(t *testing.T) {
	base := types.ModelInfo{ProviderID: "anthropic", MaxOutputTokens: 64000}
	// User config overrides with a non-zero value.
	merged := MergeModelInfo(base, types.ModelInfo{MaxOutputTokens: 96000})
	if merged.MaxOutputTokens != 96000 {
		t.Errorf("user override: merged MaxOutputTokens = %d, want 96000", merged.MaxOutputTokens)
	}
	// User config leaves it zero → base value preserved.
	merged = MergeModelInfo(base, types.ModelInfo{})
	if merged.MaxOutputTokens != 64000 {
		t.Errorf("no override: merged MaxOutputTokens = %d, want 64000 (base preserved)", merged.MaxOutputTokens)
	}
}
