package auth

import (
	"testing"
	"time"
)

func resetCache(t *testing.T) {
	t.Helper()
	InvalidateAllHasKey()
	SetNegativeCacheTTL(0)
	t.Cleanup(func() {
		InvalidateAllHasKey()
		SetNegativeCacheTTL(0)
	})
}

func TestNegativeCache_RemembersAMiss(t *testing.T) {
	resetCache(t)

	if hasNegative("", "anthropic") {
		t.Fatal("cache should start empty")
	}
	rememberNegative("", "anthropic")
	if !hasNegative("", "anthropic") {
		t.Error("a recorded negative should be readable")
	}
}

func TestNegativeCache_IsCaseInsensitive(t *testing.T) {
	resetCache(t)

	rememberNegative("", "Anthropic")
	if !hasNegative("", "anthropic") {
		t.Error("provider ids are case-insensitive elsewhere; the cache must match")
	}
}

func TestNegativeCache_ExpiresAfterTTL(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(1)

	rememberNegative("", "anthropic")
	if !hasNegative("", "anthropic") {
		t.Fatal("entry should be fresh immediately after recording")
	}

	time.Sleep(1100 * time.Millisecond)
	if hasNegative("", "anthropic") {
		t.Error("entry should have expired past its TTL")
	}
}

// The dangerous mistake this whole design is shaped around: a credential is
// added, the cached negative is not cleared, and the engine keeps insisting the
// operator has no credentials. That is worse than the log noise the cache
// removes, because the operator has no way to tell they are looking at a stale
// answer.
func TestNegativeCache_InvalidateClearsTheStaleAnswer(t *testing.T) {
	resetCache(t)

	rememberNegative("", "anthropic")
	if !hasNegative("", "anthropic") {
		t.Fatal("precondition: a negative should be cached")
	}

	InvalidateHasKey("anthropic")

	if hasNegative("", "anthropic") {
		t.Error("a credential write must make the cached negative disappear immediately")
	}
}

// OAuth entries are stored under an "oauth:<provider>" key in the file store,
// but HasKey caches under the bare provider. An invalidation that did not strip
// the prefix would clear nothing and leave the stale negative in place.
func TestNegativeCache_InvalidateStripsOAuthPrefix(t *testing.T) {
	resetCache(t)

	rememberNegative("", "anthropic")
	InvalidateHasKey("oauth:anthropic")

	if hasNegative("", "anthropic") {
		t.Error("invalidating an oauth: key must clear the bare provider's negative")
	}
}

func TestNegativeCache_InvalidateIsScopedToOneProvider(t *testing.T) {
	resetCache(t)

	rememberNegative("", "anthropic")
	rememberNegative("", "openai")
	InvalidateHasKey("anthropic")

	if hasNegative("", "anthropic") {
		t.Error("target provider should be cleared")
	}
	if !hasNegative("", "openai") {
		t.Error("an unrelated provider must not be cleared")
	}
}

func TestNegativeCache_InvalidateAllClearsEverything(t *testing.T) {
	resetCache(t)

	rememberNegative("", "anthropic")
	rememberNegative("", "openai")
	InvalidateAllHasKey()

	if hasNegative("", "anthropic") || hasNegative("", "openai") {
		t.Error("InvalidateAllHasKey should clear every entry")
	}
}

// -1 must be a true bypass, not a zero-length TTL: a disabled cache should
// never report a hit even immediately after a record.
func TestNegativeCache_DisabledNeverHits(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(-1)

	rememberNegative("", "anthropic")
	if hasNegative("", "anthropic") {
		t.Error("a disabled cache must not serve hits")
	}
}

func TestNegativeCache_ZeroSelectsDefaultTTL(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(-1)
	SetNegativeCacheTTL(0)

	rememberNegative("", "anthropic")
	if !hasNegative("", "anthropic") {
		t.Error("zero should re-enable the cache at the default TTL")
	}
}

// SetProgrammatic is the one write path that lives on the Resolver itself; the
// others (file store, keychain) are on separate types, which is why
// invalidation is exported rather than a private method.
func TestSetProgrammatic_InvalidatesCachedNegative(t *testing.T) {
	resetCache(t)

	r := NewResolver(nil)
	rememberNegative("", "anthropic")

	r.SetProgrammatic("anthropic", "sk-test")

	if hasNegative("", "anthropic") {
		t.Error("setting a programmatic key must clear the cached negative")
	}
	if ok, source := r.HasKey("anthropic"); !ok || source != "programmatic" {
		t.Errorf("HasKey = (%v, %q), want (true, \"programmatic\") immediately after the write", ok, source)
	}
}

// A cached negative must not survive a real credential appearing, which is the
// end-to-end version of the invalidation contract.
func TestHasKey_SeesAProgrammaticKeyWrittenAfterAMiss(t *testing.T) {
	resetCache(t)
	t.Setenv("HOME", t.TempDir())

	r := NewResolver(nil)

	// Force a miss so a negative is cached.
	if ok, _ := r.HasKey("nonexistent-provider"); ok {
		t.Fatal("precondition: provider should have no credentials")
	}

	r.SetProgrammatic("nonexistent-provider", "sk-test")

	if ok, _ := r.HasKey("nonexistent-provider"); !ok {
		t.Error("HasKey must see a credential added after a cached miss")
	}
}

// TestNegativeCache_IsPerPrincipal pins R-29: a negative cached while
// answering for one subject must not mask another subject's cache entry for
// the same provider.
func TestNegativeCache_IsPerPrincipal(t *testing.T) {
	resetCache(t)

	rememberNegative("alice", "anthropic")
	if !hasNegative("alice", "anthropic") {
		t.Fatal("alice's negative should be cached")
	}
	if hasNegative("bob", "anthropic") {
		t.Error("bob must not see alice's cached negative for the same provider")
	}
}

// TestNegativeCache_UnattributedUnchanged pins B-21: the unattributed
// subject ("") behaves exactly as the pre-child-07 process-wide cache did.
func TestNegativeCache_UnattributedUnchanged(t *testing.T) {
	resetCache(t)

	rememberNegative("", "anthropic")
	if !hasNegative("", "anthropic") {
		t.Error("the unattributed negative should be cached and readable")
	}
}

// TestInvalidateHasKey_ClearsEverySubject pins that InvalidateHasKey (the
// process-wide write-path invalidation) clears the negative for EVERY
// subject on that provider -- a write whose scope is unknown must not leave
// a different principal's stale negative behind.
func TestInvalidateHasKey_ClearsEverySubject(t *testing.T) {
	resetCache(t)

	rememberNegative("alice", "anthropic")
	rememberNegative("bob", "anthropic")
	rememberNegative("", "anthropic")

	InvalidateHasKey("anthropic")

	if hasNegative("alice", "anthropic") || hasNegative("bob", "anthropic") || hasNegative("", "anthropic") {
		t.Error("InvalidateHasKey should clear every subject's negative for the provider")
	}
}

// TestInvalidateHasKeySubject_ScopedToOneSubject pins that the
// subject-scoped invalidation never touches a different subject's cached
// negative for the same provider.
func TestInvalidateHasKeySubject_ScopedToOneSubject(t *testing.T) {
	resetCache(t)

	rememberNegative("alice", "anthropic")
	rememberNegative("bob", "anthropic")

	InvalidateHasKeySubject("alice", "anthropic")

	if hasNegative("alice", "anthropic") {
		t.Error("alice's negative should be cleared")
	}
	if !hasNegative("bob", "anthropic") {
		t.Error("bob's negative must survive alice's invalidation")
	}
}

// TestPositiveNeverCached pins the design's core rule: HasKey never caches a
// positive result. Two consecutive calls for a provider WITH a credential
// must each walk the resolution levels fresh, so a revoked credential is
// visible on the very next call rather than served stale from a cache.
func TestPositiveNeverCached(t *testing.T) {
	resetCache(t)

	r := NewResolver(nil)
	r.SetProgrammatic("anthropic", "sk-test")

	if ok, _ := r.HasKey("anthropic"); !ok {
		t.Fatal("expected a positive result with the programmatic key set")
	}

	// Revoke the credential directly (not through a write path that would
	// invalidate a cache) -- if HasKey cached the positive, the next call
	// would still report true.
	r.programmatic["anthropic"] = ""

	if ok, _ := r.HasKey("anthropic"); ok {
		t.Error("HasKey reported true after the credential was removed -- a positive was cached")
	}
}

// TestTTLIsBackstopNotMechanism pins R-20: explicit invalidation clears a
// cached negative immediately, well before the TTL would expire it on its
// own -- proving the TTL is a backstop for a missed invalidation, not the
// mechanism callers are expected to rely on.
func TestTTLIsBackstopNotMechanism(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(300) // long enough that the TTL alone would not save this test

	rememberNegative("alice", "anthropic")
	if !hasNegative("alice", "anthropic") {
		t.Fatal("precondition: a negative should be cached")
	}

	// Explicit invalidation must win immediately, without waiting anywhere
	// near the configured 300s TTL.
	InvalidateHasKeySubject("alice", "anthropic")

	if hasNegative("alice", "anthropic") {
		t.Error("explicit invalidation should clear the negative immediately, not wait for the TTL")
	}
}
