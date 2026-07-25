package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestApplyConfig_CompatibleProviders(t *testing.T) {
	// Each subtest calls ResetRegistries, so restore init() state when done
	// to avoid polluting later tests in the same package.
	t.Cleanup(func() { restoreInitRegistries() })

	t.Run("known provider with baseURL override", func(t *testing.T) {
		ResetRegistries()
		// Register ollama with default URL (mimics init())
		RegisterProvider(NewOpenAICompatibleProvider(CompatibleProviderOptions{
			ID:      "ollama",
			BaseURL: "http://localhost:11434/v1",
		}))

		// Apply config that overrides baseURL
		ApplyConfig(map[string]types.ProviderConfig{
			"ollama": {BaseURL: "http://remote:11434/v1"},
		})

		p := GetProvider("ollama")
		if p == nil {
			t.Fatal("expected ollama provider to be registered after ApplyConfig")
		}
		if p.ID() != "ollama" {
			t.Errorf("expected ID %q, got %q", "ollama", p.ID())
		}
	})

	t.Run("known provider with apiKey only uses default baseURL", func(t *testing.T) {
		ResetRegistries()
		RegisterProvider(NewOpenAICompatibleProvider(CompatibleProviderOptions{
			ID:      "groq",
			BaseURL: "https://api.groq.com/openai/v1",
		}))

		ApplyConfig(map[string]types.ProviderConfig{
			"groq": {APIKey: "test-key-123"},
		})

		p := GetProvider("groq")
		if p == nil {
			t.Fatal("expected groq provider to be registered after ApplyConfig with apiKey only")
		}
		if p.ID() != "groq" {
			t.Errorf("expected ID %q, got %q", "groq", p.ID())
		}
	})

	t.Run("unknown provider with baseURL registers new compatible provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"custom-llm": {BaseURL: "http://custom:8080/v1", APIKey: "key-abc"},
		})

		p := GetProvider("custom-llm")
		if p == nil {
			t.Fatal("expected custom-llm provider to be registered after ApplyConfig")
		}
		if p.ID() != "custom-llm" {
			t.Errorf("expected ID %q, got %q", "custom-llm", p.ID())
		}
	})

	t.Run("unknown provider without baseURL is skipped", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"mystery": {APIKey: "some-key"},
		})

		p := GetProvider("mystery")
		if p != nil {
			t.Errorf("expected mystery provider to NOT be registered (no baseURL), got %v", p.ID())
		}
	})
}

// TestApplyConfig_ImageProviders pins that ApplyConfig registers an
// ImageProvider alongside the chat provider for every provider with a
// baseURL. This is what lets a user-config provider (an enterprise AI
// gateway, an Azure OpenAI deployment, an on-premise endpoint) declare
// modelKind="image" models and have them route through runImageLoop:
// ResolveImageProvider(model) looks up imageProviderRegistry[providerID],
// which is only populated for these providers by this path.
func TestApplyConfig_ImageProviders(t *testing.T) {
	t.Cleanup(func() { restoreInitRegistries() })

	t.Run("openai baseURL override re-registers image provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"openai": {BaseURL: "https://ai.dcim.com", APIKey: "gw-key"},
		})

		ip := GetImageProvider("openai")
		if ip == nil {
			t.Fatal("expected openai image provider to be registered after ApplyConfig with baseURL override")
		}
		if ip.ID() != "openai" {
			t.Errorf("expected image provider ID %q, got %q", "openai", ip.ID())
		}
	})

	t.Run("known compatible provider registers image provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"together": {APIKey: "test-key"},
		})

		ip := GetImageProvider("together")
		if ip == nil {
			t.Fatal("expected together image provider to be registered after ApplyConfig")
		}
	})

	t.Run("unknown provider with baseURL registers image provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"custom-gw": {BaseURL: "https://gw.example.com", APIKey: "key-abc"},
		})

		ip := GetImageProvider("custom-gw")
		if ip == nil {
			t.Fatal("expected custom-gw image provider to be registered after ApplyConfig")
		}
	})

	t.Run("unknown provider without baseURL registers no image provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"mystery": {APIKey: "some-key"},
		})

		if ip := GetImageProvider("mystery"); ip != nil {
			t.Errorf("expected mystery image provider to NOT be registered (no baseURL), got %v", ip.ID())
		}
	})

	t.Run("user-config image model resolves through custom provider", func(t *testing.T) {
		ResetRegistries()

		ApplyConfig(map[string]types.ProviderConfig{
			"openai": {BaseURL: "https://ai.dcim.com", APIKey: "gw-key"},
		})
		// Mimic the server registering a user-config image model entry
		// (modelKind flows from models.json via modelconfig.UserModels).
		RegisterModel("FLUX.2-pro", types.ModelInfo{ProviderID: "openai", ModelKind: "image", IsCustom: true})
		t.Cleanup(func() { UnregisterModel("FLUX.2-pro") })

		ip := ResolveImageProvider("FLUX.2-pro")
		if ip == nil {
			t.Fatal("expected ResolveImageProvider to find the openai image provider for user-config FLUX.2-pro")
		}
		if ip.ID() != "openai" {
			t.Errorf("expected provider ID %q, got %q", "openai", ip.ID())
		}
	})
}
