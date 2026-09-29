package auth

import (
	"context"
	"testing"
	"time"
)

// TestInvalidatePrincipalCredential_DropsHasKeyAndAuthenticatorCache pins
// half of R-30 -- the auth-owned half of the single invalidation entry point
// (providers.InvalidatePrincipal is the full one, since it also drops the
// entitlement cache in the providers package). This test proves
// InvalidatePrincipalCredential drops both caches it owns: the HasKey
// negative and the authenticator/token cache.
func TestInvalidatePrincipalCredential_DropsHasKeyAndAuthenticatorCache(t *testing.T) {
	resetCache(t)

	rememberNegative("alice", "anthropic")
	sharedPrincipalTokenCache.entries["alice\x00scope\x00aud"] = cachedMachineToken{token: "tok"}

	InvalidatePrincipalCredential("alice", "anthropic")

	if hasNegative("alice", "anthropic") {
		t.Error("expected the HasKey negative to be dropped")
	}
	sharedPrincipalTokenCache.mu.Lock()
	_, stillCached := sharedPrincipalTokenCache.entries["alice\x00scope\x00aud"]
	sharedPrincipalTokenCache.mu.Unlock()
	if stillCached {
		t.Error("expected the authenticator/token cache entry to be dropped")
	}
}

// TestInvalidatePrincipalCredential_ScopedToOneSubject pins that
// invalidating alice's credential never touches bob's cached state.
func TestInvalidatePrincipalCredential_ScopedToOneSubject(t *testing.T) {
	resetCache(t)

	rememberNegative("alice", "anthropic")
	rememberNegative("bob", "anthropic")

	InvalidatePrincipalCredential("alice", "anthropic")

	if hasNegative("alice", "anthropic") {
		t.Error("expected alice's negative to be dropped")
	}
	if !hasNegative("bob", "anthropic") {
		t.Error("expected bob's negative to survive alice's invalidation")
	}
}

// TestNoSecondAuthenticatorCache pins R-04: subjectBoundProvider (the
// PrincipalTokenProvider adapter) caches through sharedPrincipalTokenCache --
// the SAME cache InvalidateAuthenticatorCache clears -- and not a private
// cache of its own. If a second cache existed, seeding sharedPrincipalTokenCache
// directly (as this test does) would not be visible to
// subjectBoundProvider.GetTokenWithAudience, which would instead call
// through to the inner provider again.
func TestNoSecondAuthenticatorCache(t *testing.T) {
	sharedPrincipalTokenCache.mu.Lock()
	sharedPrincipalTokenCache.entries[cacheKey("alice", "scope-x", "")] = cachedMachineToken{
		token: "cached-token", expiresAt: time.Now().Add(time.Hour),
	}
	sharedPrincipalTokenCache.mu.Unlock()
	t.Cleanup(func() { InvalidatePrincipalCredential("alice", "") })

	calls := 0
	inner := fakePrincipalTokenProvider{
		getForSubject: func(ctx context.Context, subject, scope, audience string) (string, error) {
			calls++
			return "fresh-token", nil
		},
	}
	bound := subjectBoundProvider{inner: inner, subject: "alice"}

	tok, err := bound.GetTokenWithAudience(context.Background(), "scope-x", "")
	if err != nil {
		t.Fatal(err)
	}
	if tok != "cached-token" {
		t.Errorf("token = %q, want the cache-seeded value (proves there is one shared cache, not a second private one)", tok)
	}
	if calls != 0 {
		t.Errorf("expected the cache hit to skip the inner provider entirely, got %d calls", calls)
	}
}

type fakePrincipalTokenProvider struct {
	getForSubject func(ctx context.Context, subject, scope, audience string) (string, error)
}

func (f fakePrincipalTokenProvider) GetToken(ctx context.Context, scope string) (string, error) {
	return f.GetTokenForSubject(ctx, "", scope, "")
}
func (f fakePrincipalTokenProvider) GetTokenWithAudience(ctx context.Context, scope, audience string) (string, error) {
	return f.GetTokenForSubject(ctx, "", scope, audience)
}
func (f fakePrincipalTokenProvider) GetTokenForSubject(ctx context.Context, subject, scope, audience string) (string, error) {
	return f.getForSubject(ctx, subject, scope, audience)
}
