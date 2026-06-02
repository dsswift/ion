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
