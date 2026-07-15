package server

import (
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

// selectedCliBackedProviders returns the providers whose currently-selected
// backend is a delegated CLI, mapped to that CLI kind.
func (s *Server) selectedCliBackedProviders() map[string]string {
	out := make(map[string]string)
	for _, pid := range ionconfig.CliBackedProviderIDs() {
		kind := ionconfig.SelectedBackend(s.config, pid)
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
		// Feed CLI-advertised models for the selected CLI-backed providers.
		for pid, kind := range selected {
			if p, ok := s.probes.Get(kind); ok && len(p.Models) > 0 {
				providers.SetExternalModels(pid, p.Models)
			}
		}
		utils.LogWithFields(utils.LevelInfo, "server", "provider probes refreshed", map[string]any{"kinds": kindList, "selected": len(selected)})
	}()
}

// providerCliStatus projects a cached probe onto the wire status type. Returns
// nil when the provider has no CLI backend option.
func (s *Server) providerCliStatus(providerID string) (*types.ProviderCliStatus, string) {
	kind, ok := ionconfig.CliBackendKind(providerID)
	if !ok {
		return nil, ""
	}
	selected := ionconfig.SelectedBackend(s.config, providerID)
	if s.probes == nil {
		return nil, selected
	}
	p, probed := s.probes.Get(kind)
	if !probed {
		// No probe yet: report the selected backend but leave cli status nil so
		// the client shows "unknown" rather than a false "not installed".
		return nil, selected
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
	return status, selected
}
