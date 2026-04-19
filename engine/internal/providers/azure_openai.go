package providers

import (
	"context"
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/types"
)

// AzureOptions configures the Azure OpenAI provider.
type AzureOptions struct {
	APIKey         string
	Endpoint       string // e.g. https://myresource.openai.azure.com
	APIVersion     string
	DeploymentName string
}

type azureOpenAIProvider struct {
	inner LlmProvider
}

// NewAzureOpenAIProvider creates an Azure OpenAI provider. Uses the same
// streaming translation as the standard OpenAI provider, but with Azure
// endpoint format.
func NewAzureOpenAIProvider(opts *AzureOptions) LlmProvider {
	apiKey := opts.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("AZURE_OPENAI_API_KEY")
	}

	apiVersion := opts.APIVersion
	if apiVersion == "" {
		apiVersion = "2024-02-01"
	}

	baseURL := fmt.Sprintf("%s/openai/deployments/%s", opts.Endpoint, opts.DeploymentName)

	inner := NewOpenAIProvider(&ProviderOptions{
		APIKey:  apiKey,
		BaseURL: baseURL,
	})

	return &azureOpenAIProvider{inner: inner}
}

func (p *azureOpenAIProvider) ID() string { return "azure-openai" }

func (p *azureOpenAIProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	return p.inner.Stream(ctx, opts)
}
