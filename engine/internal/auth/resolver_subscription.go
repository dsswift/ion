package auth

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
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

// SetSubscriptionStatusSource registers the reader of the Provider
// Subscription snapshot. Nil (the default) means no lookup is configured.
func (r *Resolver) SetSubscriptionStatusSource(read func() types.ProviderSubscriptionStatus) {
	r.subscriptionMu.Lock()
	r.subscriptionStatus = read
	r.subscriptionMu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "auth", "subscription status source set", map[string]any{"status": read != nil})
}

// UnappliedSubscription returns the Provider Subscription snapshot when
// providerID is the lookup's provider and no looked-up key is applied to it.
// It returns nil when no lookup is configured, when the lookup serves another
// provider, or when a looked-up key is applied.
func (r *Resolver) UnappliedSubscription(providerID string) *types.ProviderSubscriptionStatus {
	r.subscriptionMu.RLock()
	read := r.subscriptionStatus
	r.subscriptionMu.RUnlock()
	if read == nil {
		return nil
	}
	status := read()
	if status.State == types.SubscriptionStateDisabled || status.State == types.SubscriptionStateApplied {
		return nil
	}
	if status.Provider == "" || !strings.EqualFold(status.Provider, providerID) {
		return nil
	}
	return &status
}

// subscriptionKey returns the looked-up key for an already-lowercased
// provider id, or "".
func (r *Resolver) subscriptionKey(provider string) string {
	r.subscriptionMu.RLock()
	defer r.subscriptionMu.RUnlock()
	return r.subscription[provider]
}
