package telemetry

import (
	"context"
	"net/http"
	"sync"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// OtelTokenSource is a credential an OtelConfig.TokenProvider name resolves
// to. Provider is called at every mint, so a source backed by the identity
// provider follows a later sign-in.
type OtelTokenSource struct {
	Name     string // auth.oauth entry the token comes from
	Kind     string // "identity_provider" or "machine_identity"
	Provider func() auth.TokenProvider
}

var (
	otelTokenSourcesMu sync.RWMutex
	otelTokenSources   = map[string]OtelTokenSource{}
	otelUnresolvedOnce sync.Map // provider name -> struct{}; logs an unregistered name once
)

// SetOtelTokenSource registers the credential that OTLP exports naming
// tokenProvider mint from. The process entrypoint resolves each configured
// name once and registers it before the first export.
func SetOtelTokenSource(tokenProvider string, src OtelTokenSource) {
	otelTokenSourcesMu.Lock()
	otelTokenSources[tokenProvider] = src
	otelTokenSourcesMu.Unlock()
}

// otelTokenProvider returns the credential for tokenProvider and its kind.
// Empty uses the identity provider, the behavior before the field existed. A
// name nobody registered is logged once and also uses the identity provider.
func otelTokenProvider(tokenProvider string) (auth.TokenProvider, string) {
	if tokenProvider == "" {
		return currentTokenProvider(), "identity_provider"
	}
	otelTokenSourcesMu.RLock()
	src, ok := otelTokenSources[tokenProvider]
	otelTokenSourcesMu.RUnlock()
	if ok && src.Provider != nil {
		return src.Provider(), src.Kind
	}
	if _, logged := otelUnresolvedOnce.LoadOrStore(tokenProvider, struct{}{}); !logged {
		utils.LogWithFields(utils.LevelError, "telemetry.otel", "otlp token provider not registered; exports mint from the identity provider", map[string]any{
			"token_provider": tokenProvider,
		})
	}
	return currentTokenProvider(), "identity_provider"
}

// tokenProviderForLog names the configured credential for start-up logs.
func tokenProviderForLog(tokenProvider string) string {
	if tokenProvider == "" {
		return "identity_provider"
	}
	return tokenProvider
}

// metricsTokenScope is the scope the metrics export mints for: its own when
// set, else the shared OtelConfig one.
func metricsTokenScope(cfg types.OtelConfig) string {
	if cfg.Metrics != nil && cfg.Metrics.TokenScope != "" {
		return cfg.Metrics.TokenScope
	}
	return cfg.TokenScope
}

// otlpTokenAuth is what one OTLP exporter mints: a signal name for logs, the
// scope, and the configured credential name.
type otlpTokenAuth struct {
	signal   string // "traces" or "metrics"
	scope    string
	provider string // OtelConfig.TokenProvider
}

// mintBearer returns "Bearer <token>" for the configured scope and
// credential, or "" when no credential is available or the mint fails
// (logged). The export then proceeds with whatever static headers are
// configured.
func mintBearer(ctx context.Context, a otlpTokenAuth) string {
	provider, kind := otelTokenProvider(a.provider)
	fields := map[string]any{"signal": a.signal, "token_scope": a.scope, "token_provider": tokenProviderForLog(a.provider), "kind": kind}
	if provider == nil {
		utils.LogWithFields(utils.LevelWarn, "telemetry.otel", "otlp token not minted: no credential available", fields)
		return ""
	}
	token, err := provider.GetToken(ctx, a.scope)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelError, "telemetry.otel", "otlp token mint failed; export proceeds with static headers", fields)
		return ""
	}
	return "Bearer " + token
}

// tokenRoundTripper sets a freshly minted Authorization header on every
// OTLP/HTTP export request, over any static one.
type tokenRoundTripper struct {
	auth otlpTokenAuth
	next http.RoundTripper
}

func (t *tokenRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if bearer := mintBearer(req.Context(), t.auth); bearer != "" {
		req = req.Clone(req.Context())
		req.Header.Set("Authorization", bearer)
	}
	return t.next.RoundTrip(req)
}

// tokenRPCCredentials is the gRPC counterpart of tokenRoundTripper.
type tokenRPCCredentials struct {
	auth   otlpTokenAuth
	secure bool
}

func (c tokenRPCCredentials) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	if bearer := mintBearer(ctx, c.auth); bearer != "" {
		return map[string]string{"authorization": bearer}, nil
	}
	return map[string]string{}, nil
}

func (c tokenRPCCredentials) RequireTransportSecurity() bool { return c.secure }
