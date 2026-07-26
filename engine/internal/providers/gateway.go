package providers

import (
	"context"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// gatewayProvider is a dialect-dispatching provider: a strict generalization
// of the OpenAI-compatible provider for enterprise gateways that serve models
// from multiple upstream vendors behind one baseURL + auth header.
//
// Each request is delegated to an inner protocol implementation chosen by the
// model's registered Dialect (populated from the gateway's extended /models
// discovery payload or user config):
//
//	"anthropic"        -> Anthropic Messages client
//	"openai-chat"      -> OpenAI Chat Completions client
//	"openai-responses" -> OpenAI Responses client
//	"image"            -> handled by the image-provider registry (runImageLoop)
//	"" / unknown       -> OpenAI Chat Completions (byte-identical to the
//	                      compatible-provider behavior; stock providers whose
//	                      /models payload carries no dialect are unaffected)
//
// No config flag selects this provider: ApplyConfig registers it for every
// custom-baseURL provider. The gateway self-describes via the dialect fields
// in its payload. Dispatch happens per-request at stream time, after discovery
// has populated the model registry, so registration ordering is safe.
type gatewayProvider struct {
	id        string
	anthropic LlmProvider
	chat      LlmProvider
	responses LlmProvider
}

// NewGatewayProvider creates a dialect-dispatching provider. All inner
// providers share the gateway's ID, baseURL, API key, and auth header, so key
// resolution (GetProviderKey) and telemetry attribute to the gateway itself.
func NewGatewayProvider(opts CompatibleProviderOptions) LlmProvider {
	utils.LogWithFields(utils.LevelInfo, "GatewayProvider", "new dialect-dispatching provider", map[string]any{"provider": opts.ID, "path": opts.BaseURL})
	inner := &ProviderOptions{
		ID:         opts.ID,
		APIKey:     opts.APIKey,
		BaseURL:    opts.BaseURL,
		AuthHeader: opts.AuthHeader,
	}
	// The Anthropic client defaults to x-api-key auth; for a gateway the
	// configured auth header must win so all dialects authenticate uniformly.
	return &gatewayProvider{
		id:        opts.ID,
		anthropic: NewAnthropicProvider(inner),
		chat:      NewOpenAIProvider(inner),
		responses: NewOpenAIResponsesProvider(inner),
	}
}

func (p *gatewayProvider) ID() string { return p.id }

// resolveDialect looks up the model's registered dialect. Accepts both bare
// and provider-qualified ids (the qualified id is registered at discovery).
func (p *gatewayProvider) resolveDialect(model string) string {
	if info := GetModelInfo(model); info != nil && info.Dialect != "" {
		return info.Dialect
	}
	if info := GetModelInfo(p.id + "/" + model); info != nil && info.Dialect != "" {
		return info.Dialect
	}
	return ""
}

// inner returns the protocol client for the model's dialect.
func (p *gatewayProvider) inner(model string) LlmProvider {
	dialect := p.resolveDialect(model)
	switch dialect {
	case "anthropic":
		return p.anthropic
	case "openai-responses":
		return p.responses
	case "openai-chat", "":
		return p.chat
	default:
		utils.LogWithFields(utils.LevelWarn, "GatewayProvider", "unknown dialect falling back to openai-chat", map[string]any{"provider": p.id, "model": model, "reason": dialect})
		return p.chat
	}
}

func (p *gatewayProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	// Strip a provider-qualified id (e.g. "dci-marketing/claude-opus-4-8") to
	// the bare wire model — the gateway expects the vendor's model id.
	opts.Model = StripProviderQualifier(p.id, opts.Model)
	inner := p.inner(opts.Model)
	utils.LogWithFields(utils.LevelDebug, "GatewayProvider", "dispatch", map[string]any{"provider": p.id, "model": opts.Model, "reason": p.resolveDialect(opts.Model)})
	return inner.Stream(ctx, opts)
}

func (p *gatewayProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	req.Model = StripProviderQualifier(p.id, req.Model)
	return p.inner(req.Model).CountTokens(ctx, req)
}

// StripProviderQualifier removes a "<providerID>/" prefix from a model id.
// Qualified ids exist so two providers can serve the same bare model id (e.g.
// public anthropic and a gateway both serving claude-opus-4-8); on the wire
// the bare id is always sent. Ids whose prefix is not the given provider are
// returned unchanged (OpenRouter-style ids keep their slash).
func StripProviderQualifier(providerID, model string) string {
	prefix := providerID + "/"
	if strings.HasPrefix(model, prefix) {
		return strings.TrimPrefix(model, prefix)
	}
	return model
}
