package providers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// VertexConfig configures Anthropic via Google Cloud Vertex AI.
type VertexConfig struct {
	ProjectID   string
	Region      string
	AccessToken string
}

// vertexProvider wraps the inner Anthropic-protocol client with Vertex's own
// per-request token resolution (config -> auth.ResolveProviderEnv("vertex")
// -> gcloud CLI). Holds no static credential (R-23): resolveAccessToken runs
// fresh on every Stream call rather than snapshotting a token at
// construction, which fixes a latent staleness bug -- gcloud-issued access
// tokens expire within an hour, so the old construction-time snapshot went
// stale on any Vertex provider that outlived that window.
type vertexProvider struct {
	inner       LlmProvider
	configToken string // VertexConfig.AccessToken, when explicitly supplied
}

// NewVertexProvider creates an Anthropic provider routed through Vertex AI.
// projectID is resolved once at construction (config, then
// auth.ResolveProviderEnv("vertex")) because it is baked into the request
// URL, which does not vary per request the way a credential does.
func NewVertexProvider(cfg VertexConfig) (LlmProvider, error) {
	region := cfg.Region
	if region == "" {
		region = "us-east5"
	}

	projectID := cfg.ProjectID
	if projectID == "" {
		projectID, _ = auth.ResolveProviderEnvField("vertex", "projectID")
	}
	if projectID == "" {
		return nil, fmt.Errorf("vertex: no project ID configured (set VertexConfig.ProjectID or GOOGLE_CLOUD_PROJECT)")
	}

	baseURL := fmt.Sprintf(
		"https://%s-aiplatform.googleapis.com/v1/projects/%s/locations/%s/publishers/anthropic",
		region, projectID, region,
	)

	inner := NewAnthropicProvider(&ProviderOptions{
		ID:         "vertex",
		BaseURL:    baseURL,
		AuthHeader: "bearer",
	})

	return &vertexProvider{inner: inner, configToken: cfg.AccessToken}, nil
}

func (p *vertexProvider) ID() string { return p.inner.ID() }

func (p *vertexProvider) CountTokens(ctx context.Context, req CountTokensRequest) (int, error) {
	return p.inner.CountTokens(p.withResolvedToken(ctx), req)
}

func (p *vertexProvider) Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error) {
	return p.inner.Stream(p.withResolvedToken(ctx), opts)
}

// withResolvedToken attaches a freshly-resolved Vertex access token to ctx
// when the request path did not already attach one (a registered
// PrincipalCredentialSource, or the per-run resolver fallback, both take
// precedence -- R-03). Resolution order: configToken (explicit
// VertexConfig.AccessToken, an operator-configured static credential) ->
// auth.ResolveProviderEnv("vertex") (GOOGLE_ACCESS_TOKEN) -> gcloud CLI.
func (p *vertexProvider) withResolvedToken(ctx context.Context) context.Context {
	if _, ok := RequestCredentialFrom(ctx); ok {
		return ctx
	}
	token := p.configToken
	if token == "" {
		token, _ = auth.ResolveProviderEnvField("vertex", "accessToken")
	}
	if token == "" {
		token = gcloudAccessToken()
	}
	if token == "" {
		return ctx
	}
	return WithRequestCredential(ctx, staticBearerAuthenticator{token: token})
}

// staticBearerAuthenticator is the minimal RequestAuthenticator for a
// pre-resolved bearer token. Vertex's own resolution (above) is the only
// caller; it never returns the token to anything outside Authenticate.
type staticBearerAuthenticator struct{ token string }

func (a staticBearerAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	req.Header.Set("Authorization", "Bearer "+a.token)
	return nil
}

// gcloudAccessToken shells out to `gcloud auth print-access-token` (10s
// timeout), the same mechanism the pre-existing constructor-time resolution
// used. Returns "" on any failure so the caller falls through cleanly.
func gcloudAccessToken() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "gcloud", "auth", "print-access-token")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = nil

	if err := cmd.Run(); err != nil {
		return ""
	}

	return strings.TrimSpace(out.String())
}
