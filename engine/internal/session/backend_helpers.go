package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolvedBackend returns the inner backend that should handle a run for
// the given model. For non-hybrid backends (plain CliBackend or ApiBackend,
// or any test mock), it returns m.backend unchanged so existing type-
// assertion call sites continue to work without modification.
//
// For HybridBackend, it asks providers.GetModelInfo about the model and
// returns the inner *CliBackend when the resolved provider ID is
// "anthropic", or the inner *ApiBackend otherwise (including for
// unregistered models — those route to the API path where a clean
// provider error can surface).
//
// This is the single helper that localizes hybrid awareness inside the
// session package. Every former m.backend.(*backend.CliBackend) /
// (*backend.ApiBackend) type assertion is now resolvedBackend(model).(...).
func (m *Manager) resolvedBackend(model string) backend.RunBackend {
	h, ok := m.backend.(*backend.HybridBackend)
	if !ok {
		return m.backend
	}
	if info := providers.GetModelInfo(model); info != nil && info.ProviderID == "anthropic" {
		utils.Debug("Session", "resolvedBackend: model="+model+" providerID=anthropic → inner CliBackend")
		return h.InnerCli()
	}
	utils.Debug("Session", "resolvedBackend: model="+model+" → inner ApiBackend (default)")
	return h.InnerApi()
}

// newChildBackend returns a fresh RunBackend of the same kind as the
// Manager's parent backend. All child-agent dispatch paths must use this
// instead of calling NewApiBackend()/NewCliBackend() directly, so that
// backend: "cli" sessions produce CLI children and backend: "hybrid"
// sessions produce hybrid children whose inner *ApiBackend inherits the
// parent's auth resolver.
func (m *Manager) newChildBackend() backend.RunBackend {
	switch b := m.backend.(type) {
	case *backend.CliBackend:
		return backend.NewCliBackend()
	case *backend.HybridBackend:
		// HybridBackend.NewChild propagates the auth resolver from the
		// parent's inner *ApiBackend so non-Claude child runs can resolve
		// provider credentials. Without this, dispatching ion_agent with
		// model: "gpt-4.1" under hybrid would fail silently.
		return b.NewChild()
	default:
		return backend.NewApiBackend()
	}
}
