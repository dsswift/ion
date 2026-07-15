package config

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// allowedProviderBackends lists the backend kinds each provider may be pinned
// to via providers.<id>.backend. The empty string ("") is always allowed and
// means "use the default routing rule" (see HybridBackend). A provider absent
// from this map may only use "api" (or "").
//
// This is the mechanism side of the opinionless-core principle: the engine
// owns which backend kind can serve which provider; the operator owns the
// choice within those bounds.
var allowedProviderBackends = map[string][]string{
	"anthropic": {"api", "claude-code"},
	"openai":    {"api", "codex"},
	"xai":       {"api", "grok"},
	"cursor":    {"cursor"},
}

// providerCliKind maps a provider to the CLI backend kind it can delegate to.
// A provider absent from this map is API-only (no delegated CLI). This is the
// capability map (which CLI a provider COULD use), distinct from the operator's
// current selection.
var providerCliKind = map[string]string{
	"anthropic": "claude-code",
	"openai":    "codex",
	"xai":       "grok",
	"cursor":    "cursor",
}

// CliBackendKind returns the CLI backend kind a provider can delegate to and
// whether it has one at all.
func CliBackendKind(providerID string) (string, bool) {
	k, ok := providerCliKind[providerID]
	return k, ok
}

// CliBackedProviderIDs returns every provider that has a delegated CLI option.
func CliBackedProviderIDs() []string {
	ids := make([]string, 0, len(providerCliKind))
	for pid := range providerCliKind {
		ids = append(ids, pid)
	}
	return ids
}

// SelectedBackend returns the run backend currently selected for a provider:
// the operator's explicit preference when valid, otherwise the default rule
// (anthropic → claude-code, cursor → cursor, every other provider → api).
func SelectedBackend(cfg *types.EngineRuntimeConfig, providerID string) string {
	if cfg != nil {
		if pc, ok := cfg.Providers[providerID]; ok && pc.Backend != "" && backendAllowedFor(providerID, pc.Backend) {
			return pc.Backend
		}
	}
	switch providerID {
	case "anthropic":
		return "claude-code"
	case "cursor":
		return "cursor"
	default:
		return "api"
	}
}

// backendAllowedFor reports whether kind is a permitted backend for the given
// provider. "" (default rule) is always permitted.
func backendAllowedFor(providerID, kind string) bool {
	if kind == "" {
		return true
	}
	allowed, ok := allowedProviderBackends[providerID]
	if !ok {
		// Providers with no explicit entry may only use the API backend.
		return kind == "api"
	}
	for _, a := range allowed {
		if a == kind {
			return true
		}
	}
	return false
}

// validateProviderBackends checks every provider's Backend against the allowed
// set and resets invalid values to "" (default rule) with an ERROR log. It
// keeps the engine serving on a malformed config rather than refusing to start
// — the same fail-open posture the rest of config load uses. Mutates cfg in
// place. Both the valid and the reset branches are logged.
func validateProviderBackends(cfg *types.EngineRuntimeConfig) {
	if cfg == nil {
		return
	}
	for pid, pc := range cfg.Providers {
		if pc.Backend == "" {
			continue
		}
		if backendAllowedFor(pid, pc.Backend) {
			utils.LogWithFields(utils.LevelInfo, "config", "provider backend preference accepted", map[string]any{"provider": pid, "backend": pc.Backend})
			continue
		}
		utils.LogWithFields(utils.LevelError, "config", "invalid provider backend preference, falling back to default rule", map[string]any{
			"provider": pid,
			"backend":  pc.Backend,
			"allowed":  allowedProviderBackends[pid],
		})
		pc.Backend = ""
		cfg.Providers[pid] = pc
	}
}

// ProviderBackendPrefs returns the provider→backend-kind map for every
// provider that has an explicit, valid backend preference. Providers using the
// default rule are omitted (HybridBackend fills the default at routing time).
// Call after validateProviderBackends so only sane values survive.
func ProviderBackendPrefs(cfg *types.EngineRuntimeConfig) map[string]string {
	if cfg == nil {
		return nil
	}
	prefs := make(map[string]string)
	for pid, pc := range cfg.Providers {
		if pc.Backend != "" {
			prefs[pid] = pc.Backend
		}
	}
	if len(prefs) == 0 {
		return nil
	}
	return prefs
}
