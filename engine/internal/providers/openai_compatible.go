package providers

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CompatibleProviderOptions configures an OpenAI-compatible provider.
type CompatibleProviderOptions struct {
	ID      string
	APIKey  string
	BaseURL string
}

// NewOpenAICompatibleProvider creates a provider for any OpenAI-API-compatible
// endpoint: Groq, Cerebras, Mistral, OpenRouter, Together, Fireworks, XAI,
// DeepSeek, Ollama, etc.
func NewOpenAICompatibleProvider(opts CompatibleProviderOptions) LlmProvider {
	utils.Log("CompatProvider", fmt.Sprintf("NewOpenAICompatibleProvider: id=%s baseURL=%s", opts.ID, opts.BaseURL))
	p := NewOpenAIProvider(&ProviderOptions{
		ID:      opts.ID,
		APIKey:  opts.APIKey,
		BaseURL: opts.BaseURL,
	})

	// Wrap to override ID
	return &compatibleWrapper{
		inner: p,
		id:    opts.ID,
	}
}

type compatibleWrapper struct {
	inner LlmProvider
	id    string
}

func (w *compatibleWrapper) ID() string { return w.id }

func (w *compatibleWrapper) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	return w.inner.Stream(ctx, opts)
}
