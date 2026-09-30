package main

import (
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/subscription"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// startSubscriptionLookup starts the Provider Subscription lookup when
// engine.json (or enterprise policy) configures one. It resolves per
// verified identity, so it starts once identity readiness has run. An
// invalid block is logged and skipped: manual key entry keeps working and
// startup is never blocked. The returned func stops it.
func startSubscriptionLookup(cfg *types.EngineRuntimeConfig, resolver *auth.Resolver, srv *server.Server) func() {
	if cfg.SubscriptionLookup == nil {
		utils.LogWithFields(utils.LevelDebug, "main", "subscription lookup not configured", nil)
		return func() {}
	}
	lookup := *cfg.SubscriptionLookup
	if err := subscription.Validate(lookup); err != nil {
		utils.LogWithFields(utils.LevelError, "main", "subscription lookup config invalid; manual key entry only", map[string]any{"error": err.Error()})
		return func() {}
	}
	if _, ok := cfg.Providers[lookup.Provider]; !ok {
		utils.LogWithFields(utils.LevelWarn, "main", "subscription lookup names a provider with no providers entry", map[string]any{"provider": lookup.Provider})
	}
	keys := discoveringKeys{resolver: resolver, providerConfigs: cfg.Providers}
	manager := subscription.NewManager(lookup, subscription.HTTPFetcher, subscription.NewFileStoreCache(), keys, srv.BroadcastProviderSubscription)
	srv.SetSubscriptionManager(manager)
	manager.Start()
	return manager.Stop
}

// discoveringKeys applies a looked-up key and then rediscovers the
// provider's models with it, the way store_credential does, so a key that
// lands after startup discovery still fills the model list.
type discoveringKeys struct {
	resolver        *auth.Resolver
	providerConfigs map[string]types.ProviderConfig
}

func (k discoveringKeys) SetSubscriptionKey(providerID, key string) {
	k.resolver.SetSubscriptionKey(providerID, key)
	go providers.DiscoverProvider(providerID, key, k.providerConfigs)
}

func (k discoveringKeys) ClearSubscriptionKey(providerID string) {
	k.resolver.ClearSubscriptionKey(providerID)
}
