package main

import (
	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// startApplicationConfig installs the authenticated application config
// store when engine.json declares a source, forwarding its transitions to
// extensions. It runs after identity readiness so the store's first look
// at the identity sees a grant reconciled at startup. With no source
// declared the subsystem stays inert: nothing is installed and every
// reader sees the disabled state. The returned func tears it down.
func startApplicationConfig(cfg *types.EngineRuntimeConfig, manager *session.Manager) func() {
	if cfg == nil || cfg.ApplicationConfig == nil || cfg.ApplicationConfig.Endpoint == "" {
		utils.LogWithFields(utils.LevelInfo, "main", "application config not configured", nil)
		return func() {}
	}
	stopHooks := manager.WatchApplicationConfig()
	store := appconfig.NewStore(*cfg.ApplicationConfig, appconfig.HTTPFetcher)
	appconfig.Install(store)
	store.Start()
	return func() {
		store.Stop()
		appconfig.Install(nil)
		stopHooks()
	}
}
