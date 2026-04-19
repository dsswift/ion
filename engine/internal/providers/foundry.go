package providers

import (
	"fmt"
	"os"
)

// FoundryConfig configures Anthropic Foundry (dedicated capacity).
type FoundryConfig struct {
	BaseURL string
	APIKey  string
}

// NewFoundryProvider creates an Anthropic provider routed through Foundry.
func NewFoundryProvider(cfg FoundryConfig) (LlmProvider, error) {
	baseURL := firstNonEmpty(cfg.BaseURL, os.Getenv("ANTHROPIC_FOUNDRY_BASE_URL"))
	if baseURL == "" {
		return nil, fmt.Errorf("foundry: no base URL configured (set FoundryConfig.BaseURL or ANTHROPIC_FOUNDRY_BASE_URL)")
	}

	apiKey := firstNonEmpty(cfg.APIKey, os.Getenv("ANTHROPIC_FOUNDRY_API_KEY"), os.Getenv("ANTHROPIC_API_KEY"))

	return NewAnthropicProvider(&ProviderOptions{
		ID:     "foundry",
		BaseURL: baseURL,
		APIKey:  apiKey,
	}), nil
}

// firstNonEmpty returns the first non-empty string from the arguments.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
