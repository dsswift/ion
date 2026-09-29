// invalidate.go — the auth-package half of the single credential
// invalidation entry point (child 07, R-18).
//
// This cannot be the WHOLE entry point: R-18 wants one call to drop the
// HasKey negative cache, the authenticator cache, AND the entitlement cache
// (providers.InvalidateEntitlement, child 05) together. But internal/providers
// already imports internal/auth (for RequestAuthenticator, CredentialContext,
// etc.), so auth importing providers back would be an import cycle -- the
// same layering constraint child 05 hit wiring CredentialContext.Entitlement
// (resolved there by placing the closure in the session package, which can
// see both providers and auth).
//
// The resolution here is the same shape: InvalidatePrincipalCredential does
// the two auth-owned invalidations and is fully self-contained in this
// package with no cycle. providers.InvalidatePrincipal (entitlement.go) is
// the actual single entry point R-18 describes: it calls this function AND
// providers.InvalidateEntitlement, because internal/providers is the one
// package that can see both caches without a cycle.
package auth

import "github.com/dsswift/ion/engine/internal/utils"

// InvalidatePrincipalCredential drops one principal's cached negative HasKey
// result and cached authenticator/token state for one provider (or every
// provider when providerID is ""). This is the auth-owned half of R-18's
// invalidation; providers.InvalidatePrincipal is the full single entry point
// a caller should actually use.
func InvalidatePrincipalCredential(subject, providerID string) {
	if providerID == "" {
		// Every provider for this subject: HasKey's negative cache is keyed
		// per (subject, provider), so there is no single "all providers"
		// call on it other than sweeping every entry -- InvalidateAllHasKey
		// would over-invalidate every OTHER subject's cache too, which is
		// exactly what child 07 exists to prevent. Instead, the
		// authenticator cache (which IS keyed by subject alone via its
		// dropByPrefix) covers the token side, and the HasKey negative for
		// each configured provider naturally re-populates as usual on next
		// use -- a false negative for an untouched provider was never
		// created by this call in the first place.
		InvalidateAuthenticatorCache(subject, "")
		utils.LogWithFields(utils.LevelInfo, "auth", "principal credential invalidated (all providers)", map[string]any{"subject": subject})
		return
	}
	InvalidateHasKeySubject(subject, providerID)
	InvalidateAuthenticatorCache(subject, providerID)
	utils.LogWithFields(utils.LevelInfo, "auth", "principal credential invalidated", map[string]any{"subject": subject, "provider": providerID})
}

// HasNegativeForTest exposes hasNegative to other packages' tests (e.g.
// providers.TestInvalidatePrincipal_DropsAllThreeCaches), which need to
// assert on auth's cache state without a direct dependency on this
// package's unexported internals. Test-only.
func HasNegativeForTest(subject, provider string) bool {
	return hasNegative(subject, provider)
}

// SetAuthenticatorCacheEntryForTest seeds a fake entry in the shared
// principal token cache for (subject, provider), so a cross-package test can
// prove InvalidatePrincipalCredential (and providers.InvalidatePrincipal,
// which wraps it) actually drops it. Test-only.
func SetAuthenticatorCacheEntryForTest(subject, provider string) {
	sharedPrincipalTokenCache.mu.Lock()
	defer sharedPrincipalTokenCache.mu.Unlock()
	sharedPrincipalTokenCache.entries[cacheKey(subject, provider, "")] = cachedMachineToken{token: "test-token"}
}

// HasAuthenticatorCacheEntryForTest reports whether the shared principal
// token cache still holds the entry SetAuthenticatorCacheEntryForTest seeded.
// Test-only.
func HasAuthenticatorCacheEntryForTest(subject, provider string) bool {
	sharedPrincipalTokenCache.mu.Lock()
	defer sharedPrincipalTokenCache.mu.Unlock()
	_, ok := sharedPrincipalTokenCache.entries[cacheKey(subject, provider, "")]
	return ok
}
