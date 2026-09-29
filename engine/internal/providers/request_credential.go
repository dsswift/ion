package providers

import (
	"context"
	"net/http"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/utils"
)

// credentialKey is the unexported context key for the acting principal's
// request-scoped authenticator (SC-2 delivery). A context.Context carries the
// value rather than a package-level variable so it is scoped to one request,
// never process-wide -- this is the seam that replaces the deleted
// providerKeys map (R-02, R-15).
type credentialKey struct{}

// credentialRefusalKey is the unexported context key for a pre-request
// refusal decision (SC-4, R-07): an attributed principal whose
// CredentialContext.Authenticator returned auth.ErrPrincipalCredentialUnresolved
// (child 04's fall-through policy said no). Distinct from "no credential
// attached at all" -- that case falls through to requireKeyForHost's
// narrower canonical-host gate, but a REFUSED principal must never
// silently proceed keyless against a custom base URL, which
// requireKeyForHost would otherwise permit.
type credentialRefusalKey struct{}

// WithRequestCredential attaches auth to ctx so a provider's request-time
// code can retrieve it via RequestCredentialFrom. Called once per outbound
// attempt by resolveProviderAndAttachAuth (the initial resolve) and by
// RetryConfig.AttachAuth (a fallback-chain hop), never stored anywhere beyond
// the context value itself.
func WithRequestCredential(ctx context.Context, a auth.RequestAuthenticator) context.Context {
	return context.WithValue(ctx, credentialKey{}, a)
}

// RequestCredentialFrom retrieves the authenticator attached to ctx, if any.
// ok is false when no request credential was ever attached -- an
// unattributed run whose CredentialContext was nil, or a call made outside
// any run (count_tokens invoked directly, for instance).
func RequestCredentialFrom(ctx context.Context) (auth.RequestAuthenticator, bool) {
	a, ok := ctx.Value(credentialKey{}).(auth.RequestAuthenticator)
	return a, ok
}

// WithCredentialRefusal marks ctx as belonging to an attributed principal
// whose credential resolution was refused (fall-through policy said no).
// applyRequestAuth checks this before anything else, so the refusal fires
// pre-request regardless of what requireKeyForHost would otherwise permit
// for a keyless custom base URL.
func WithCredentialRefusal(ctx context.Context, subject string) context.Context {
	return context.WithValue(ctx, credentialRefusalKey{}, subject)
}

// credentialRefusalFrom reports whether ctx carries a refusal and the
// subject it was refused for.
func credentialRefusalFrom(ctx context.Context) (string, bool) {
	subject, ok := ctx.Value(credentialRefusalKey{}).(string)
	return subject, ok
}

// applyRequestAuth centralizes what every provider now does at request time,
// replacing the repeated "read p.apiKey, fall back to GetProviderKey, fail
// fast on a key-required host, setAuthHeader" block that used to live in each
// provider's doStream. Returns a non-nil *ProviderError when the request must
// not be sent (see the failure branches below); nil means req is
// authenticated (or legitimately keyless) and the caller should proceed.
func applyRequestAuth(ctx context.Context, req *http.Request, body []byte, providerID string) *ProviderError {
	if subject, refused := credentialRefusalFrom(ctx); refused {
		return NewPrincipalCredentialError(providerID, subject)
	}
	a, ok := RequestCredentialFrom(ctx)
	if !ok || a == nil {
		utils.LogWithFields(utils.LevelDebug, "Auth", "no request credential on context", map[string]any{
			"provider": providerID, "path": req.URL.Host,
		})
		// Preserves B-13/B-14: a canonical hosted endpoint with no credential
		// fails fast before the request is built; a custom base URL may be
		// legitimately keyless and is never gated.
		if pe := requireKeyForHost(req.URL.Host, providerID, ""); pe != nil {
			return pe
		}
		return nil
	}
	if err := a.Authenticate(ctx, req, body); err != nil {
		utils.LogWithFields(utils.LevelError, "Auth", "request authentication failed", map[string]any{
			"provider": providerID, "error": err.Error(),
		})
		return NewProviderError(ErrAuth, err.Error(), 401, false)
	}
	utils.LogWithFields(utils.LevelDebug, "Auth", "request authenticated", map[string]any{
		"provider": providerID, "path": req.URL.Host,
	})
	return nil
}
