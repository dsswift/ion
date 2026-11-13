package extcontext

import (
	"context"
	"net/http"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/tests/helpers"
)

// keyRecordingProvider is the mock provider, recording the key the request
// credential on each call's context would send.
type keyRecordingProvider struct {
	*helpers.MockProvider
	key string
}

func (p *keyRecordingProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	if a, ok := providers.RequestCredentialFrom(ctx); ok && a != nil {
		req, _ := http.NewRequest(http.MethodPost, "https://gateway.example/v1/messages", nil)
		if a.Authenticate(ctx, req, nil) == nil {
			p.key = req.Header.Get("Authorization") + req.Header.Get("x-api-key")
		}
	}
	return p.MockProvider.Stream(ctx, opts)
}

// credentialAccessor wires a credential context the way the session layer
// does for the acting principal.
type credentialAccessor struct {
	*llmCallTestAccessor
	cc *auth.CredentialContext
}

func (a *credentialAccessor) WirePrincipalRunConfig(cfg *backend.RunConfig) {
	cfg.CredentialContext = a.cc
}

// TestLLMCall_AuthenticatesAsTheSessionPrincipal pins that a one-shot call
// carries the acting principal's provider credential, exactly as the run
// loop and dispatched agents do. Without it a gateway that needs a key
// answers 401 to every LLMCall while agent turns on the same session pass.
func TestLLMCall_AuthenticatesAsTheSessionPrincipal(t *testing.T) {
	const model = "test-model-tiny"
	mock := registerMockProvider(t, model)
	mock.SetResponse(helpers.TextResponse("ok"))
	rec := &keyRecordingProvider{MockProvider: mock}
	providers.RegisterProvider(rec)
	resolver := auth.NewResolver(nil)
	resolver.SetProgrammatic("test-mock", "k-123")
	acc := &credentialAccessor{
		llmCallTestAccessor: &llmCallTestAccessor{extGroup: extension.NewExtensionGroup()},
		cc:                  auth.NewCredentialContext(nil, resolver, nil),
	}
	if _, err := BuildLLMCallFunc(acc)(extension.LLMCallOpts{Model: model, Prompt: "hi"}); err != nil {
		t.Fatal(err)
	}
	if rec.key != "Bearer k-123" {
		t.Fatalf("the provider request carried key %q, want the principal's key", rec.key)
	}
}
