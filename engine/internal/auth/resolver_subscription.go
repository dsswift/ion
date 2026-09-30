package auth

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// SourceSubscription names the resolution level that serves a key the
// Provider Subscription lookup applied.
const SourceSubscription = "subscription"

// SubscriptionCachePrefix prefixes the credential-store entries where the
// Provider Subscription lookup caches a selected key. They are not manual
// provider keys, so credential listings skip them.
const SubscriptionCachePrefix = "subscription-lookup:"

// SetSubscriptionKey applies a key resolved by the Provider Subscription
// lookup. It outranks every other level, so a looked-up key wins over a
// manually configured one; clearing it lets the manual key serve again.
func (r *Resolver) SetSubscriptionKey(providerID, key string) {
	provider := strings.ToLower(providerID)
	r.subscriptionMu.Lock()
	r.subscription[provider] = key
	r.subscriptionMu.Unlock()
	InvalidateHasKey(provider)
	utils.LogWithFields(utils.LevelInfo, "auth", "subscription key applied", map[string]any{"provider": provider, "count": len(key)})
}

// ClearSubscriptionKey removes the looked-up key for a provider. Resolution
// falls back to the manual levels.
func (r *Resolver) ClearSubscriptionKey(providerID string) {
	provider := strings.ToLower(providerID)
	r.subscriptionMu.Lock()
	_, had := r.subscription[provider]
	delete(r.subscription, provider)
	r.subscriptionMu.Unlock()
	InvalidateHasKey(provider)
	utils.LogWithFields(utils.LevelInfo, "auth", "subscription key cleared", map[string]any{"provider": provider, "status": had})
}

// subscriptionKey returns the looked-up key for an already-lowercased
// provider id, or "".
func (r *Resolver) subscriptionKey(provider string) string {
	r.subscriptionMu.RLock()
	defer r.subscriptionMu.RUnlock()
	return r.subscription[provider]
}
