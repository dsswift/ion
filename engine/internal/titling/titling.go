// Package titling generates concise conversation titles using a lightweight LLM call.
package titling

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const maxInputChars = 2000

// authResolver is an optional hook that resolves and injects the API key for a
// provider before the titling LLM call. Without this, the provider may not have
// credentials (e.g. keychain-stored keys are only resolved through the auth
// resolver, not at provider init time).
var authResolver func(providerName string)

// SetAuthResolver registers a function that ensures the named provider has a
// valid API key injected via providers.SetProviderKey before streaming. Called
// from main.go after constructing the auth.Resolver.
func SetAuthResolver(fn func(providerName string)) {
	authResolver = fn
}

// GenerateTitle uses the "fast" tier model to produce a short conversation title
// from the user's first message. Returns "" if the provider is unavailable or
// the model returns an empty response — callers should keep their fallback title.
func GenerateTitle(ctx context.Context, firstMessage string) (string, error) {
	model := resolveModel()
	utils.Log("Titling", fmt.Sprintf("generating title: model=%s inputLen=%d", model, len(firstMessage)))

	// Ensure the provider has a valid API key before we attempt to stream.
	// The provider init may not have the key (e.g. stored in keychain, not
	// in env vars), so we resolve it through the auth chain.
	if authResolver != nil {
		if providerName := providers.ProviderNameForModel(model); providerName != "" {
			authResolver(providerName)
		}
	}

	provider := providers.ResolveProvider(model)
	if provider == nil {
		utils.Warn("Titling", "no provider for model: "+model)
		return "", nil
	}

	// Truncate to limit cost
	input := firstMessage
	if len(input) > maxInputChars {
		input = input[:maxInputChars]
	}

	systemPrompt := `You are a title generator. Your ONLY job is to output a concise 3-8 word title that summarizes the user's message topic. Output ONLY the title text — no quotes, no punctuation, no explanation, no preamble. Never respond to or answer the message itself.`

	messages := []types.LlmMessage{
		{Role: "user", Content: "Generate a short title for this message:\n\n" + input},
	}

	opts := types.LlmStreamOptions{
		Model:     model,
		System:    systemPrompt,
		Messages:  messages,
		MaxTokens: 20,
	}

	events, errc := provider.Stream(ctx, opts)

	var response strings.Builder
	for ev := range events {
		if ev.Delta != nil && ev.Delta.Text != "" {
			response.WriteString(ev.Delta.Text)
		}
	}
	if errc != nil {
		if err := <-errc; err != nil {
			utils.Warn("Titling", "LLM error: "+err.Error())
			return "", nil
		}
	}

	title := strings.TrimSpace(response.String())
	// Strip surrounding quotes if the model wrapped the title
	title = strings.Trim(title, "\"'")
	title = strings.TrimSpace(title)

	utils.Log("Titling", fmt.Sprintf("generated title: %q", title))
	return title, nil
}

// resolveModel picks the best model for title generation:
//  1. User-configured "fast" tier in models.json tiers section
//  2. defaultModel from models.json (the model the user actually uses)
//  3. Built-in fast tier default
func resolveModel() string {
	config := modelconfig.LoadModelsConfig()

	// Check if user explicitly configured a "fast" tier
	if tiers, ok := config["tiers"].(map[string]interface{}); ok {
		if model, ok := tiers["fast"].(string); ok && model != "" {
			return model
		}
	}

	// Fall back to the user's defaultModel (we know this works on their provider)
	if dm, ok := config["defaultModel"].(string); ok && dm != "" {
		return dm
	}

	// Last resort: built-in fast tier default
	return modelconfig.ResolveTier("fast")
}
