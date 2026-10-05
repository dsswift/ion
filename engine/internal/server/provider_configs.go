package server

import (
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// providerConfigs is the provider configuration in force: the boot config
// less every provider removed since. The boot map is never mutated, so a
// caller that already holds it keeps a consistent view.
func (s *Server) providerConfigs() map[string]types.ProviderConfig {
	if s.config == nil {
		return nil
	}
	s.removedProvidersMu.RLock()
	defer s.removedProvidersMu.RUnlock()
	if len(s.removedProviders) == 0 {
		return s.config.Providers
	}
	out := make(map[string]types.ProviderConfig, len(s.config.Providers))
	for id, cfg := range s.config.Providers {
		if !s.removedProviders[id] {
			out[id] = cfg
		}
	}
	return out
}

// markProviderRemoved drops a provider from providerConfigs.
func (s *Server) markProviderRemoved(providerID string) {
	s.removedProvidersMu.Lock()
	defer s.removedProvidersMu.Unlock()
	if s.removedProviders == nil {
		s.removedProviders = map[string]bool{}
	}
	s.removedProviders[providerID] = true
}

// isCustomProvider reports whether a configured provider exists only because
// configuration defines it: neither a built-in HTTP provider nor one served
// by a delegated CLI.
func isCustomProvider(providerID string) bool {
	if providers.IsBuiltinProvider(providerID) {
		return false
	}
	_, cli := ionconfig.CliBackendKind(providerID)
	return !cli
}
