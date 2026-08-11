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

	if hasNegative("anthropic") {
		t.Fatal("cache should start empty")
	}
	rememberNegative("anthropic")
	if !hasNegative("anthropic") {
		t.Error("a recorded negative should be readable")
	}
}

func TestNegativeCache_IsCaseInsensitive(t *testing.T) {
	resetCache(t)

	rememberNegative("Anthropic")
	if !hasNegative("anthropic") {
		t.Error("provider ids are case-insensitive elsewhere; the cache must match")
	}
}

func TestNegativeCache_ExpiresAfterTTL(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(1)

	rememberNegative("anthropic")
	if !hasNegative("anthropic") {
		t.Fatal("entry should be fresh immediately after recording")
	}

	time.Sleep(1100 * time.Millisecond)
	if hasNegative("anthropic") {
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

	rememberNegative("anthropic")
	if !hasNegative("anthropic") {
		t.Fatal("precondition: a negative should be cached")
	}

	InvalidateHasKey("anthropic")

	if hasNegative("anthropic") {
		t.Error("a credential write must make the cached negative disappear immediately")
	}
}

// OAuth entries are stored under an "oauth:<provider>" key in the file store,
// but HasKey caches under the bare provider. An invalidation that did not strip
// the prefix would clear nothing and leave the stale negative in place.
func TestNegativeCache_InvalidateStripsOAuthPrefix(t *testing.T) {
	resetCache(t)

	rememberNegative("anthropic")
	InvalidateHasKey("oauth:anthropic")

	if hasNegative("anthropic") {
		t.Error("invalidating an oauth: key must clear the bare provider's negative")
	}
}

func TestNegativeCache_InvalidateIsScopedToOneProvider(t *testing.T) {
	resetCache(t)

	rememberNegative("anthropic")
	rememberNegative("openai")
	InvalidateHasKey("anthropic")

	if hasNegative("anthropic") {
		t.Error("target provider should be cleared")
	}
	if !hasNegative("openai") {
		t.Error("an unrelated provider must not be cleared")
	}
}

func TestNegativeCache_InvalidateAllClearsEverything(t *testing.T) {
	resetCache(t)

	rememberNegative("anthropic")
	rememberNegative("openai")
	InvalidateAllHasKey()

	if hasNegative("anthropic") || hasNegative("openai") {
		t.Error("InvalidateAllHasKey should clear every entry")
	}
}

// -1 must be a true bypass, not a zero-length TTL: a disabled cache should
// never report a hit even immediately after a record.
func TestNegativeCache_DisabledNeverHits(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(-1)

	rememberNegative("anthropic")
	if hasNegative("anthropic") {
		t.Error("a disabled cache must not serve hits")
	}
}

func TestNegativeCache_ZeroSelectsDefaultTTL(t *testing.T) {
	resetCache(t)
	SetNegativeCacheTTL(-1)
	SetNegativeCacheTTL(0)

	rememberNegative("anthropic")
	if !hasNegative("anthropic") {
		t.Error("zero should re-enable the cache at the default TTL")
	}
}

// SetProgrammatic is the one write path that lives on the Resolver itself; the
// others (file store, keychain) are on separate types, which is why
// invalidation is exported rather than a private method.
func TestSetProgrammatic_InvalidatesCachedNegative(t *testing.T) {
	resetCache(t)

	r := NewResolver(nil)
	rememberNegative("anthropic")

	r.SetProgrammatic("anthropic", "sk-test")

	if hasNegative("anthropic") {
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
