package providers

import "github.com/dsswift/ion/engine/internal/auth"

// FoundryConfig configures Anthropic Foundry (dedicated capacity).
type FoundryConfig struct {
	BaseURL string
	APIKey  string
}

// NewFoundryProvider creates an Anthropic provider routed through Foundry.
//
// Holds no environment-derived credential (R-23): ANTHROPIC_FOUNDRY_API_KEY /
// ANTHROPIC_API_KEY are no longer read here -- they resolve through
// auth.Resolver (providerEnvVars["foundry"], child 01) at request time via
// the per-run CredentialContext, exactly like every other provider.
// cfg.BaseURL still wins when explicitly supplied; otherwise
// ANTHROPIC_FOUNDRY_BASE_URL resolves via auth.ResolveProviderEnvField,
// matching the pre-existing env fallback the constructor used to read
// directly.
func NewFoundryProvider(cfg FoundryConfig) (LlmProvider, error) {
	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL, _ = auth.ResolveProviderEnvField("foundry", "baseURL")
	}
	return NewAnthropicProvider(&ProviderOptions{
		ID:      "foundry",
		BaseURL: baseURL,
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
