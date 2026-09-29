package auth

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// PrincipalTokenProvider is the optional per-principal extension of
// TokenProvider (R-04). A TokenProvider that implements it can mint a token
// scoped to a specific acting principal rather than only the process-wide
// identity; one that does not is used unchanged for subject "" (see
// TokenProviderForSubject), so every existing consumer -- extension HTTP,
// telemetry, OIDC dispatch -- keeps working with no edit.
type PrincipalTokenProvider interface {
	TokenProvider
	GetTokenForSubject(ctx context.Context, subject, scope, audience string) (string, error)
}

// subjectBoundProvider adapts a PrincipalTokenProvider to plain TokenProvider
// for one fixed subject, so a caller that only knows TokenProvider (extension
// HTTP's BearerAuthenticator, child 10) gets a principal-scoped token with no
// change to its own call shape. Caching and singleflight run through
// sharedPrincipalTokenCache, keyed by (subject, scope, audience) -- the same
// mechanism GetToken/GetTokenWithAudience already use for subject "", not a
// second one (R-04).
type subjectBoundProvider struct {
	inner   PrincipalTokenProvider
	subject string
}

func (p subjectBoundProvider) GetToken(ctx context.Context, scope string) (string, error) {
	return p.GetTokenWithAudience(ctx, scope, "")
}

func (p subjectBoundProvider) GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error) {
	return sharedPrincipalTokenCache.getOrAcquire(ctx, p.subject, "principal", "subject-bound", scope, audience,
		func(ctx context.Context) (string, time.Time, error) {
			tok, err := p.inner.GetTokenForSubject(ctx, p.subject, scope, audience)
			if err != nil {
				return "", time.Time{}, err
			}
			// GetTokenForSubject returns a token, not an expiry: the
			// underlying provider owns its own refresh cadence and this
			// adapter only needs a cache entry to coalesce repeat callers
			// within one turn. The default threshold reproduces that
			// coalescing window without claiming a false precise expiry.
			return tok, time.Now().Add(defaultRefreshThreshold), nil
		})
}

// TokenProviderForSubject returns a TokenProvider scoped to subject. An
// empty subject, a nil current provider, or a provider with no principal
// dimension all return CurrentTokenProvider() unchanged -- a single-user
// engine, or a provider that never implemented PrincipalTokenProvider, is
// therefore unaffected by this seam's existence (child 10 depends on this).
func TokenProviderForSubject(subject string) TokenProvider {
	p := CurrentTokenProvider()
	if subject == "" || p == nil {
		return p
	}
	if pp, ok := p.(PrincipalTokenProvider); ok {
		return subjectBoundProvider{inner: pp, subject: subject}
	}
	return p
}

// InvalidateAuthenticatorCache drops one principal's cached tokens from the
// existing sharedPrincipalTokenCache. There is no second cache anywhere in
// this program (R-04); child 07 calls this as part of its single
// invalidation entry point. The prefix is "<subject>\x00" -- cacheKey's
// leading segment -- which matches every scope/audience cached for exactly
// that subject and nothing else, since \x00 cannot occur inside a subject.
func InvalidateAuthenticatorCache(subject, providerID string) {
	sharedPrincipalTokenCache.dropByPrefix(subject + "\x00")
	utils.LogWithFields(utils.LevelInfo, "auth", "authenticator cache dropped", map[string]any{"subject": subject, "provider": providerID})
}
