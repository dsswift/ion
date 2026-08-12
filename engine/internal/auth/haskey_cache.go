// haskey_cache.go — negative-result cache for HasKey.
//
// HasKey walks five resolution levels, and levels 3-4c are I/O: a keychain
// lookup, two encrypted-file-store reads, and a credentials.json read. On a
// MISS it pays all of them. Backend init calls it several times per provider,
// and parallel sub-agents multiply that, so an unconfigured provider produced
// a burst of identical filesystem work and identical log lines — the observed
// case was three "no credentials found" lines inside 12 milliseconds.
//
// NEGATIVE RESULTS ONLY. Caching a positive would keep handing out a
// credential the operator has revoked, which turns a cheap lookup into a
// security problem. A negative is the safe direction: the worst case is one
// extra walk.
//
// The invalidation is the whole correctness burden. A cache that misses an
// invalidation makes a freshly-added credential invisible, which is worse than
// the noise it removes — an operator who just signed in would watch the engine
// insist they had not. So every write path calls InvalidateHasKey, and the TTL
// exists only as a backstop for a writer nobody remembered to wire up (an
// external process editing credentials.json, say), never as the primary
// mechanism.

package auth

import (
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultNegativeCacheTTL bounds how long a stale negative can survive an
// invalidation that never came. Short enough that an unwired writer costs
// seconds rather than a session, long enough to collapse an init burst.
const DefaultNegativeCacheTTL = 5 * time.Second

type negativeEntry struct {
	at time.Time
}

var (
	negCacheMu  sync.RWMutex
	negCache    = make(map[string]negativeEntry)
	negCacheTTL = DefaultNegativeCacheTTL
	// negCacheDisabled short-circuits every path, so `-1` is a true bypass
	// rather than a zero-length TTL that still takes locks.
	negCacheDisabled bool
)

// SetNegativeCacheTTL configures the cache. Zero selects the default; a
// negative value disables caching entirely.
func SetNegativeCacheTTL(seconds int) {
	negCacheMu.Lock()
	defer negCacheMu.Unlock()

	switch {
	case seconds < 0:
		negCacheDisabled = true
		negCache = make(map[string]negativeEntry)
	case seconds == 0:
		negCacheDisabled = false
		negCacheTTL = DefaultNegativeCacheTTL
	default:
		negCacheDisabled = false
		negCacheTTL = time.Duration(seconds) * time.Second
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache configured", map[string]any{
		"disabled": negCacheDisabled, "ttl_seconds": negCacheTTL.Seconds(),
	})
}

// hasNegative reports whether a fresh negative result is cached.
func hasNegative(provider string) bool {
	negCacheMu.RLock()
	defer negCacheMu.RUnlock()
	if negCacheDisabled {
		return false
	}
	entry, ok := negCache[strings.ToLower(provider)]
	if !ok {
		return false
	}
	return time.Since(entry.at) < negCacheTTL
}

// rememberNegative records that a provider resolved to no credentials.
func rememberNegative(provider string) {
	negCacheMu.Lock()
	defer negCacheMu.Unlock()
	if negCacheDisabled {
		return
	}
	negCache[strings.ToLower(provider)] = negativeEntry{at: time.Now()}
}

// InvalidateHasKey drops the cached negative for one provider.
//
// Every credential write path must call this. It is exported because the
// writers live on other types (FileStore, the keychain helpers) that have no
// reference to a Resolver.
func InvalidateHasKey(provider string) {
	provider = strings.ToLower(strings.TrimPrefix(provider, "oauth:"))

	negCacheMu.Lock()
	_, existed := negCache[provider]
	delete(negCache, provider)
	negCacheMu.Unlock()

	if existed {
		utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache invalidated", map[string]any{
			"provider": provider,
		})
	}
}

// InvalidateAllHasKey drops every cached negative. Used when a write's scope
// is unknown, and by tests.
func InvalidateAllHasKey() {
	negCacheMu.Lock()
	size := len(negCache)
	negCache = make(map[string]negativeEntry)
	negCacheMu.Unlock()

	if size > 0 {
		utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache cleared", map[string]any{
			"entries": size,
		})
	}
}
