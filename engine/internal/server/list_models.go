package server

import (
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// buildModelsList constructs the response for the list_models RPC.
//
// Responsibilities:
//   - resolve per-provider HasAuth/AuthSource via the auth resolver
//   - apply special cases: ollama always authed (local), and anthropic authed
//     "via cli" when the engine is running a CLI-capable backend (cli or
//     hybrid) without a separate Anthropic API key
//   - populate provider gateway / api-key reference details from config
//   - filter the hardcoded model catalog down to only user-configured /
//     discovered models for providers that route through a custom gateway
//
// Extracted from server.go to keep the dispatch switch focused and to keep
// server.go under the file-size cap.
func (s *Server) buildModelsList() map[string]interface{} {
	models := providers.ListModels()
	providerIDs := providers.ListProviderIDs()
	providerEntries := make([]types.ProviderEntry, len(providerIDs))
	for i, pid := range providerIDs {
		entry := types.ProviderEntry{ID: pid}
		if s.authResolver != nil {
			entry.HasAuth, entry.AuthSource = s.authResolver.HasKey(pid)
		}
		// Special case: ollama doesn't need auth
		if pid == "ollama" {
			entry.HasAuth = true
			entry.AuthSource = "none"
		}
		// CLI-capable backend (cli or hybrid) handles Anthropic auth via the
		// Claude CLI itself. Surface that to clients so the model picker
		// doesn't hide Anthropic models when no separate API key is
		// configured.
		if s.cliCapable && pid == "anthropic" && !entry.HasAuth {
			entry.HasAuth = true
			entry.AuthSource = "cli"
		}
		// Populate config details (gateway URL, API key reference)
		if s.config != nil {
			if pc, ok := s.config.Providers[pid]; ok {
				entry.BaseURL = pc.BaseURL
				if pc.APIKey != "" {
					if pc.APIKey[0] == '$' {
						entry.APIKeyRef = pc.APIKey
					} else {
						entry.APIKeyRef = "configured"
					}
				}
			}
		}
		providerEntries[i] = entry
	}

	// For providers with a custom gateway (baseURL), only show user-configured
	// models or live-discovered models -- the hardcoded catalog doesn't apply
	// to private gateways.
	customGatewayProviders := make(map[string]bool)
	if s.config != nil {
		for pid, pc := range s.config.Providers {
			if pc.BaseURL != "" {
				customGatewayProviders[pid] = true
			}
		}
	}
	if len(customGatewayProviders) > 0 {
		discoveredIDs := make(map[string]bool)
		for pid := range customGatewayProviders {
			for _, dm := range providers.GetDiscoveredModels(pid) {
				discoveredIDs[dm.ID] = true
			}
		}
		filtered := make([]types.ModelEntry, 0, len(models))
		for _, m := range models {
			if customGatewayProviders[m.ProviderID] && !m.IsCustom && !discoveredIDs[m.ID] {
				continue // skip hardcoded catalog models for custom gateway providers
			}
			filtered = append(filtered, m)
		}
		models = filtered
	}

	return map[string]interface{}{
		"models":    models,
		"providers": providerEntries,
	}
}
