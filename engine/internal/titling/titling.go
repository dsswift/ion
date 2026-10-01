// Package titling generates concise conversation titles using a lightweight LLM call.
package titling

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	maxInputChars = 2000
	// Upper bound on a generated title, in runes.
	//
	// This is a SANITY bound against a model that ignores its narrow prompt and
	// returns a sentence, a refusal, or an answer to the message — not a style
	// budget. It must therefore stay above what the system prompt actually asks
	// for: that prompt requests a 3-8 word title, and eight ordinary English
	// words plus separators run past 55 characters. The previous value of 40
	// sat BELOW the prompt's own upper request, so a model that complied
	// exactly was rejected for being too long and the caller silently kept its
	// fallback title — a self-contradiction between the prompt and the guard.
	// 80 covers the full 3-8 word request with headroom while still rejecting
	// prose.
	titleMaxChars  = 80
	titleMaxTokens = 256

	titleSystemPrompt = `You are a title generator. Your ONLY job is to output a concise 3-8 word title that summarizes the user's message topic. Output ONLY the title text — no quotes, no punctuation, no explanation, no preamble. Never respond to or answer the message itself.`
)

// authResolver attaches a request credential to ctx for the named provider
// before the titling LLM call, so the request authenticates instead of
// relying on the provider having a credential of its own (providers hold
// none since R-23). Without this, a keychain- or file-store-stored key would
// never reach the request. Set via SetAuthResolver from main.go for the
// process-wide (unattributed) path; a session-specific call
// (GenerateTitleForPrincipal) supplies its own hook built from that
// session's CredentialContext instead.
var authResolver func(ctx context.Context, providerName string) context.Context

// SetAuthResolver registers the process-wide credential-attachment hook used
// by GenerateTitle (the unattributed path). Called from main.go after
// constructing the auth.Resolver.
func SetAuthResolver(fn func(ctx context.Context, providerName string) context.Context) {
	authResolver = fn
}

// DelegatedGenerator answers a title prompt through a delegated CLI instead of
// a provider API. handled is false when no delegated CLI serves model, in
// which case the provider API path runs; when handled is true the returned
// text or error is final.
type DelegatedGenerator func(ctx context.Context, model, system, prompt string) (text string, handled bool, err error)

var delegatedGenerator DelegatedGenerator

// SetDelegatedGenerator registers the delegated-CLI path GenerateTitle tries
// before the provider API. Called from main.go when the configured backend can
// generate text; nil leaves the provider API as the only path.
func SetDelegatedGenerator(fn DelegatedGenerator) {
	delegatedGenerator = fn
}

// GenerateTitle uses the "fast" tier model to produce a short conversation title
// from the user's first message. Returns "" if no model is configured, the
// provider is unavailable, or the model returns an empty response. Callers
// should keep their fallback title.
func GenerateTitle(ctx context.Context, firstMessage string) (string, error) {
	return generateTitle(ctx, firstMessage, authResolver)
}

// GenerateTitleForPrincipal is GenerateTitle with an explicit credential
// hook, so a session-scoped call authenticates as that session's acting
// principal (R-11) rather than the process-wide fallback. attachAuth may be
// nil (falls through to no credential attachment, matching an unattributed
// GenerateTitle call with no resolver configured).
func GenerateTitleForPrincipal(ctx context.Context, firstMessage string, attachAuth func(ctx context.Context, providerName string) context.Context) (string, error) {
	return generateTitle(ctx, firstMessage, attachAuth)
}

func generateTitle(ctx context.Context, firstMessage string, attachAuth func(ctx context.Context, providerName string) context.Context) (string, error) {
	model := resolveModel()
	if model == "" {
		utils.Log("Titling", "no model configured for titling, skipping")
		return "", nil
	}
	utils.LogWithFields(utils.LevelInfo, "titling", "generating title", map[string]any{"model": model, "count": len(firstMessage)})

	// Truncate to limit cost. The bound is in RUNES, not bytes: `input[:N]` on a
	// string slices bytes, so a multibyte prompt (CJK, emoji, accented Latin)
	// was cut mid-character and the model received a trailing invalid UTF-8
	// sequence. The name has always said "chars"; only the arithmetic disagreed.
	input := firstMessage
	if utf8.RuneCountInString(input) > maxInputChars {
		input = string([]rune(input)[:maxInputChars])
	}
	prompt := "Generate a short title for this message:\n\n" + input

	raw, handled, ok := generateViaDelegatedCLI(ctx, model, prompt)
	if !handled {
		raw, ok = generateViaProvider(ctx, model, prompt, attachAuth)
	}
	if !ok {
		return "", nil
	}
	return sanitizeTitle(model, raw), nil
}

// generateViaDelegatedCLI asks the registered delegated generator for the
// title text. handled is false when there is no generator or no delegated CLI
// serves model, which leaves the provider API to try. When handled is true,
// ok reports whether the CLI produced text.
func generateViaDelegatedCLI(ctx context.Context, model, prompt string) (text string, handled, ok bool) {
	if delegatedGenerator == nil {
		utils.LogWithFields(utils.LevelDebug, "titling", "no delegated generator registered", map[string]any{"model": model})
		return "", false, false
	}
	text, handled, err := delegatedGenerator(ctx, model, titleSystemPrompt, prompt)
	if !handled {
		utils.LogWithFields(utils.LevelDebug, "titling", "model not served by a delegated cli", map[string]any{"model": model})
		return "", false, false
	}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "titling", "delegated cli error", map[string]any{"model": model, "error": err.Error()})
		return "", true, false
	}
	utils.LogWithFields(utils.LevelInfo, "titling", "title text from delegated cli", map[string]any{"model": model, "count": len(text)})
	return text, true, true
}

// generateViaProvider streams the title text from the model's provider API.
// ok is false when there is no provider, the stream errored, or the response
// was cut off; each is logged here.
func generateViaProvider(ctx context.Context, model, prompt string, attachAuth func(ctx context.Context, providerName string) context.Context) (string, bool) {
	// Attach a request credential for the resolved provider before we attempt
	// to stream. The provider itself holds none (R-23); the credential must
	// travel on ctx.
	if attachAuth != nil {
		if providerName := providers.ProviderNameForModel(model); providerName != "" {
			ctx = attachAuth(ctx, providerName)
		}
	}

	provider := providers.ResolveProvider(model)
	if provider == nil {
		utils.LogWithFields(utils.LevelWarn, "titling", "no provider for model", map[string]any{"model": model})
		return "", false
	}

	// Title generation is bounded even if a model ignores its narrow prompt. It
	// also explicitly disables provider reasoning: a title needs no deliberation,
	// and reserving its tiny output budget for hidden reasoning was the root cause
	// of missing visible titles.
	opts := types.LlmStreamOptions{
		Model:           model,
		System:          titleSystemPrompt,
		Messages:        []types.LlmMessage{{Role: "user", Content: prompt}},
		MaxTokens:       titleMaxTokens,
		Thinking:        &types.ThinkingConfig{Enabled: false},
		DisableThinking: true,
	}

	events, errc := provider.Stream(ctx, opts)

	var response strings.Builder
	var outputTokens int
	stopReason := ""
	for ev := range events {
		if ev.Delta != nil && ev.Delta.Text != "" {
			response.WriteString(ev.Delta.Text)
		}
		if ev.Delta != nil && ev.Delta.StopReason != nil {
			stopReason = *ev.Delta.StopReason
		}
		if ev.DeltaUsage != nil {
			outputTokens = ev.DeltaUsage.OutputTokens
		}
	}
	if errc != nil {
		if err := <-errc; err != nil {
			utils.LogWithFields(utils.LevelWarn, "titling", "llm error", map[string]any{"model": model, "error": err.Error()})
			return "", false
		}
	}

	if stopReason == "max_tokens" || stopReason == "length" {
		utils.LogWithFields(utils.LevelWarn, "titling", "title generation incomplete", map[string]any{
			"model": model, "stop_reason": stopReason, "output_tokens": outputTokens,
		})
		return "", false
	}
	return response.String(), true
}

// sanitizeTitle trims the model's raw answer into a title, or returns "" when
// the answer is empty or too long to be one.
func sanitizeTitle(model, raw string) string {
	title := strings.TrimSpace(raw)
	// Strip surrounding quotes if the model wrapped the title
	title = strings.Trim(title, "\"'")
	title = strings.TrimSpace(title)
	if title == "" {
		utils.LogWithFields(utils.LevelWarn, "titling", "title generation empty", map[string]any{"model": model})
		return ""
	}
	titleChars := utf8.RuneCountInString(title)
	if titleChars > titleMaxChars {
		utils.LogWithFields(utils.LevelWarn, "titling", "title generation too long", map[string]any{
			"model": model, "count": titleChars, "max": titleMaxChars,
		})
		return ""
	}

	utils.LogWithFields(utils.LevelInfo, "titling", "generated title", map[string]any{"model": model, "title": title})
	return title
}

// resolveModel picks the best model for title generation:
//  1. User-configured "fast" tier in models.json tiers section
//  2. defaultModel from models.json (the model the user actually uses)
//
// Returns an empty string when neither is set. Callers should skip titling
// rather than substitute a built-in default. The engine ships no model opinions.
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

	return ""
}
