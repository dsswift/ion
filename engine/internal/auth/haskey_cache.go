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
//
// Keyed by (subject, provider) as of child 07 (R-14): the resolver's own
// process-wide levels have no principal dimension, but HasKey's PROCESS-WIDE
// negative was shared across every caller regardless of who was asking. On a
// shared instance, one principal's miss would cache a negative that then
// masked a DIFFERENT principal's genuinely available credential for the TTL
// window -- the cache existed to remove noise, not to misreport someone
// else's access. subject "" is the unattributed key, so a single-user engine
// (every existing call site) is unaffected byte for byte.

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

type negKey struct{ Subject, Provider string }

type negativeEntry struct {
	at time.Time
}

var (
	negCacheMu  sync.RWMutex
	negCache    = make(map[negKey]negativeEntry)
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
		negCache = make(map[negKey]negativeEntry)
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

// hasNegative reports whether a fresh negative result is cached for
// (subject, provider). subject "" is the unattributed key.
func hasNegative(subject, provider string) bool {
	negCacheMu.RLock()
	defer negCacheMu.RUnlock()
	if negCacheDisabled {
		return false
	}
	entry, ok := negCache[negKey{Subject: subject, Provider: strings.ToLower(provider)}]
	if !ok {
		return false
	}
	return time.Since(entry.at) < negCacheTTL
}

// rememberNegative records that (subject, provider) resolved to no
// credentials.
func rememberNegative(subject, provider string) {
	negCacheMu.Lock()
	defer negCacheMu.Unlock()
	if negCacheDisabled {
		return
	}
	negCache[negKey{Subject: subject, Provider: strings.ToLower(provider)}] = negativeEntry{at: time.Now()}
}

// InvalidateHasKey drops the cached negative for one provider, across EVERY
// subject. Every credential write path calls this: a process-wide write
// (SetProgrammatic, a file-store write, a keychain write) has no way to know
// which principal's cached negative it should have invalidated, so it
// invalidates all of them -- correctness over precision, since the cost of a
// missed invalidation (a stale "no credential" the operator can see is
// wrong) is worse than the cost of an extra re-check for an unaffected
// principal.
//
// It is exported because the writers live on other types (FileStore, the
// keychain helpers) that have no reference to a Resolver.
func InvalidateHasKey(provider string) {
	provider = strings.ToLower(strings.TrimPrefix(provider, "oauth:"))

	negCacheMu.Lock()
	dropped := 0
	for k := range negCache {
		if k.Provider == provider {
			delete(negCache, k)
			dropped++
		}
	}
	negCacheMu.Unlock()

	if dropped > 0 {
		utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache invalidated", map[string]any{
			"provider": provider, "entries": dropped,
		})
	}
}

// InvalidateHasKeySubject drops the cached negative for exactly one
// (subject, provider) pair -- the principal-scoped counterpart to
// InvalidateHasKey, used by InvalidatePrincipal (child 07's single
// invalidation entry point) so invalidating one principal's credential state
// never touches another principal's cached negative for the same provider.
func InvalidateHasKeySubject(subject, provider string) {
	provider = strings.ToLower(strings.TrimPrefix(provider, "oauth:"))

	negCacheMu.Lock()
	_, existed := negCache[negKey{Subject: subject, Provider: provider}]
	delete(negCache, negKey{Subject: subject, Provider: provider})
	negCacheMu.Unlock()

	if existed {
		utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache invalidated for subject", map[string]any{
			"subject": subject, "provider": provider,
		})
	}
}

// InvalidateAllHasKey drops every cached negative, for every subject. Used
// when a write's scope is unknown, and by tests.
func InvalidateAllHasKey() {
	negCacheMu.Lock()
	size := len(negCache)
	negCache = make(map[negKey]negativeEntry)
	negCacheMu.Unlock()

	if size > 0 {
		utils.LogWithFields(utils.LevelDebug, "auth", "haskey negative cache cleared", map[string]any{
			"entries": size,
		})
	}
}
