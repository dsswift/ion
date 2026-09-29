package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// launchRun is the last step of SendPrompt: it hands the fully built run to
// the backend. Split out of prompt_dispatch.go at its natural seam so the
// dispatch file stays under the size cap; every comment below travelled with
// the code it describes.
//
// Dispatch to backend. ApiBackend uses the per-run config built above so
// every closure on this run sees this session's hooks/tools/perms. A
// delegated-CLI backend follows its own subprocess wiring and takes only
// the run's telemetry collector (backend.RunTelemetrySetter).
//
// HybridBackend implements both StartRun and StartRunWithConfig: it
// records the routing decision for opts.Model and forwards to the
// inner *ApiBackend (with runCfg) or an inner CLI backend (with only the
// telemetry collector).
// We dispatch through m.backend here (not resolvedBackend) so the
// hybrid layer sees the call and can record its routing table entry
// before forwarding.
// StartRun may schedule work immediately, and callbacks acquire Manager.mu.
// Validate ownership under the lock, then release it before launch. The run
// identity and routing binding remain committed, so a synchronous callback
// resolves normally instead of deadlocking on this manager.
func (m *Manager) launchRun(key string, s *engineSession, requestID string, opts types.RunOptions, runCfg *backend.RunConfig) error {
	m.mu.Lock()
	current, stillActive := m.sessions[key]
	if !stillActive || current != s || current.requestID != requestID {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "prompt dispatch abandoned before backend start", map[string]any{"key": key, "run_id": requestID})
		return fmt.Errorf("session %q stopped before backend start", key)
	}
	launchAck := make(chan struct{})
	s.launchingRunID = requestID
	s.launchAck = launchAck
	m.mu.Unlock()
	if hybrid, ok := m.backend.(*backend.HybridBackend); ok {
		hybrid.StartRunWithConfig(requestID, opts, runCfg)
	} else if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		apiBackend.StartRunWithConfig(requestID, opts, runCfg)
	} else {
		if setter, ok := m.backend.(backend.RunTelemetrySetter); ok && runCfg != nil && runCfg.Telemetry != nil {
			setter.SetRunTelemetry(requestID, runCfg.Telemetry)
		}
		m.backend.StartRun(requestID, opts)
	}
	m.mu.Lock()
	if current, ok := m.sessions[key]; ok && current == s && current.launchAck == launchAck {
		current.launchingRunID = ""
		current.launchAck = nil
	}
	close(launchAck)
	m.mu.Unlock()
	return nil
}
