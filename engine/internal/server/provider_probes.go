package server

import (
	"github.com/dsswift/ion/engine/internal/backend"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// isCliKind reports whether a backend selection names a delegated CLI backend.
func isCliKind(kind string) bool {
	switch kind {
	case "claude-code", "codex", "grok", "cursor":
		return true
	default:
		return false
	}
}

// cliAuthedProbe returns the live install+auth predicate over the server's
// probe registry, in the shape backend.EffectiveBackendForProvider and
// HybridBackend.SetCliAuthProbe expect. The closure captures the registry, so
// every call observes the current probe state — a login completed after
// wiring is visible on the very next routing decision. Nil when the registry
// is absent (routing then degrades to api).
func (s *Server) cliAuthedProbe() func(kind string) bool {
	if s.probes == nil {
		return nil
	}
	probes := s.probes
	return func(kind string) bool {
		p, ok := probes.Get(kind)
		return ok && p.Installed && p.Authenticated
	}
}

// effectiveBackendFor returns the credential-derived backend for a provider —
// the same decision HybridBackend routing makes, via the shared helper — so
// every server-side projection (provider entries, discovery skip set, model
// feeding) matches what routing actually picks.
func (s *Server) effectiveBackendFor(providerID string) string {
	var keys backend.KeyHaver
	if s.authResolver != nil {
		keys = s.authResolver
	}
	pref := ionconfig.ExplicitBackendPref(s.config, providerID)
	return backend.EffectiveBackendForProvider(providerID, keys, s.cliAuthedProbe(), pref)
}

// selectedCliBackedProviders returns the providers whose credential-derived
// effective backend is a delegated CLI, mapped to that CLI kind. Live: the
// answer changes as keys are added/removed and CLI logins complete.
func (s *Server) selectedCliBackedProviders() map[string]string {
	out := make(map[string]string)
	for _, pid := range ionconfig.CliBackedProviderIDs() {
		kind := s.effectiveBackendFor(pid)
		if isCliKind(kind) {
			out[pid] = kind
		}
	}
	return out
}

// RefreshProviderProbes re-interrogates the delegated CLIs for the currently
// selected CLI-backed providers, updates the HTTP-discovery skip set, and feeds
// each CLI's advertised models into the discovery store. Runs the probes in the
// background so the caller (startup, refresh_models) never blocks on a CLI.
func (s *Server) RefreshProviderProbes() {
	if s.probes == nil {
		return
	}
	selected := s.selectedCliBackedProviders()

	// Providers served by a CLI backend skip HTTP model discovery — their
	// models come from the probe below.
	skip := make(map[string]bool, len(selected))
	for pid := range selected {
		skip[pid] = true
	}
	providers.SetCliBackedProviders(skip)

	// Probe every CLI kind a provider can use (not just the selected one) so
	// the desktop can show install/auth state for alternatives the user might
	// switch to.
	kinds := map[string]bool{}
	for _, pid := range ionconfig.CliBackedProviderIDs() {
		if kind, ok := ionconfig.CliBackendKind(pid); ok {
			kinds[kind] = true
		}
	}
	kindList := make([]string, 0, len(kinds))
	for k := range kinds {
		kindList = append(kindList, k)
	}

	go func() {
		s.probes.Refresh(kindList)
		// Recompute the effective selection with FRESH probes: a CLI that just
		// probed as authed flips its provider to CLI-backed, and vice versa.
		// The pre-refresh `selected` above seeded the skip set from the prior
		// probe state; this post-refresh pass is the authoritative one.
		refreshed := s.selectedCliBackedProviders()
		skip := make(map[string]bool, len(refreshed))
		for pid := range refreshed {
			skip[pid] = true
		}
		providers.SetCliBackedProviders(skip)
		// Feed CLI-advertised models for the CLI-backed providers.
		for pid, kind := range refreshed {
			if p, ok := s.probes.Get(kind); ok && len(p.Models) > 0 {
				providers.SetExternalModels(pid, p.Models)
			}
		}
		utils.LogWithFields(utils.LevelInfo, "server", "provider probes refreshed", map[string]any{"kinds": kindList, "selected_pre": len(selected), "selected_post": len(refreshed)})
	}()
}

// providerCliStatus projects a cached probe onto the wire status type. Returns
// nil when the provider has no CLI backend option. The second return is the
// credential-derived effective backend (what routing will actually pick), not
// a stored preference.
func (s *Server) providerCliStatus(providerID string) (*types.ProviderCliStatus, string) {
	kind, ok := ionconfig.CliBackendKind(providerID)
	if !ok {
		return nil, ""
	}
	effective := s.effectiveBackendFor(providerID)
	if s.probes == nil {
		return nil, effective
	}
	p, probed := s.probes.Get(kind)
	if !probed {
		// No probe yet: report the effective backend but leave cli status nil so
		// the client shows "unknown" rather than a false "not installed".
		return nil, effective
	}
	status := &types.ProviderCliStatus{
		Backend:       kind,
		Installed:     p.Installed,
		BinaryPath:    p.BinaryPath,
		Version:       p.Version,
		Authenticated: p.Authenticated,
		AuthMethod:    p.AuthMethod,
		PlanType:      p.PlanType,
		Email:         p.Email,
		Label:         p.Label,
	}
	return status, effective
}
