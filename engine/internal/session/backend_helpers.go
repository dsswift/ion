package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// modelRefFor builds the extension.ModelRef the engine hangs on ctx.Model for
// model-aware hooks (notably before_prompt). It carries the SELECTED model ID
// and its context window, resolved from the same registry cost/thinking/routing
// all read (providers.GetModelInfo). Unknown models yield a zero-value window,
// so a handler can still branch on ctx.Model.ID without a nil-window panic.
func modelRefFor(model string) *extension.ModelRef {
	ref := &extension.ModelRef{ID: model}
	if info := providers.GetModelInfo(model); info != nil {
		ref.ContextWindow = info.ContextWindow
	}
	return ref
}

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
		utils.LogWithFields(utils.LevelDebug, "session", "resolvedbackend: model= providerid=anthropic → inner clibackend", map[string]any{"model": model})
		return h.InnerCli()
	}
	utils.LogWithFields(utils.LevelDebug, "session", "resolvedbackend: model= → inner apibackend (default)", map[string]any{"model": model})
	return h.InnerApi()
}

// newChildBackend returns a fresh RunBackend of the same kind as the
// Manager's parent backend. All child-agent dispatch paths must use this
// instead of calling NewApiBackend()/NewCliBackend() directly, so that
// backend: "cli" sessions produce CLI children and backend: "hybrid"
// sessions produce hybrid children whose inner *ApiBackend inherits the
// parent's auth resolver.
//
// When m.childBackendOverride is set (test-only), the override factory
// runs instead. This is the only injection point unit tests have to
// substitute a stubbed child backend for the spawner closure.
func (m *Manager) newChildBackend() backend.RunBackend {
	if m.childBackendOverride != nil {
		return m.childBackendOverride()
	}
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

// progressBumpable is satisfied by any backend that exposes the run-progress
// watchdog clock for refreshing. *ApiBackend implements it directly; the
// HybridBackend's parent runs live on its inner *ApiBackend (returned by
// InnerApi), which also implements it. CliBackend and test stubs do not, so
// the bump degrades to a no-op for them.
type progressBumpable interface {
	BumpRunProgress(requestID string)
}

// bumpParentProgress refreshes the parent run's run-progress watchdog clock for
// the given session's active run. It is the session-side half of the dispatch
// liveness fix: a healthy child agent's events flow on the *child* backend and
// never reach the parent run's emit(), so the parent — parked in the deadline-
// exempt Agent tool call — would have a stalling progress clock once the
// self-emitted ToolStalledEvent advisory stopped counting as progress (see
// ApiBackend.emitWithoutProgress). Calling this on every genuine child event
// reports the child's liveness to the parent's clock.
//
// Resolution: read the session's current requestID under the Manager lock (the
// same guard SendAbort uses), then ask the resolved parent backend to bump it.
// No-op when there is no active run or the backend cannot bump (CLI / stubs).
//
// The bump targets the parent ApiBackend directly rather than going through
// resolvedBackend(model): for HybridBackend the parent run is always on the
// inner *ApiBackend (the CLI inner does not run the run-progress watchdog), so
// InnerApi() is the correct and only target.
func (m *Manager) bumpParentProgress(s *engineSession) {
	if s == nil {
		return
	}
	m.mu.Lock()
	rid := s.requestID
	m.mu.Unlock()
	if rid == "" {
		return
	}

	target := m.backend
	if h, ok := m.backend.(*backend.HybridBackend); ok {
		target = h.InnerApi()
	}
	if pb, ok := target.(progressBumpable); ok {
		pb.BumpRunProgress(rid)
	}
}

// humanWaitSuspendable is satisfied by any backend that lets the run-progress
// watchdog be paused for an intentional, indefinite human-wait (an elicitation
// or a permission dialog awaiting a user decision). *ApiBackend implements it
// directly; the HybridBackend's parent runs live on its inner *ApiBackend
// (InnerApi), which also implements it. CliBackend and test stubs do not, so the
// begin/end pair degrades to a no-op for them.
type humanWaitSuspendable interface {
	BeginHumanWait(requestID string)
	EndHumanWait(requestID string)
}

// beginHumanWait tells the parent run's run-progress watchdog that the given
// session's active run is entering an intentional, indefinite human-wait, so the
// watchdog must not cancel it for idleness while a user decision is pending. Must
// be paired with endHumanWait on every exit path (use defer at the call site).
//
// Resolution mirrors bumpParentProgress exactly: read the session's current
// requestID under the Manager lock, resolve the parent ApiBackend (InnerApi for
// HybridBackend — the CLI inner does not run the run-progress watchdog), and
// forward. No-op when there is no active run or the backend cannot suspend
// (CLI / stubs); the indefinite-human-wait guarantee for those backends is
// enforced by their own dialog layers, not by this watchdog.
func (m *Manager) beginHumanWait(s *engineSession) {
	if s == nil {
		return
	}
	m.mu.Lock()
	rid := s.requestID
	m.mu.Unlock()
	if rid == "" {
		return
	}

	target := m.backend
	if h, ok := m.backend.(*backend.HybridBackend); ok {
		target = h.InnerApi()
	}
	if hw, ok := target.(humanWaitSuspendable); ok {
		hw.BeginHumanWait(rid)
	}
}

// endHumanWait is the matched half of beginHumanWait: it tells the parent run's
// run-progress watchdog that a human-wait span has ended, resuming the watchdog
// (with a fresh idle window) once the run's last open human-wait closes. Safe to
// defer; same resolution and no-op semantics as beginHumanWait.
func (m *Manager) endHumanWait(s *engineSession) {
	if s == nil {
		return
	}
	m.mu.Lock()
	rid := s.requestID
	m.mu.Unlock()
	if rid == "" {
		return
	}

	target := m.backend
	if h, ok := m.backend.(*backend.HybridBackend); ok {
		target = h.InnerApi()
	}
	if hw, ok := target.(humanWaitSuspendable); ok {
		hw.EndHumanWait(rid)
	}
}
