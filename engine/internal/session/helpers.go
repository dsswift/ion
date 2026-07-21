package session

import (
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/telemetry"
)

// keyForRun finds the session key that owns the given request ID.
func (m *Manager) keyForRun(runID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	// Primary: the stable runID -> key binding, set at dispatch and cleared
	// only at terminal points. This is decoupled from engineSession.requestID,
	// which currentSessionStatus clears when the backend disclaims a run — a
	// clear that historically fired mid-dispatch (now guarded by
	// dispatchingRunID) and previously caused the scan below to return "" and
	// silently drop in-flight events (see run_key_binding.go for the full
	// rationale).
	if key := m.keyForRunBinding(runID); key != "" {
		return key
	}
	// Fallback: scan sessions by the live requestID. Retained so a run that
	// somehow has no binding (defensive) still resolves while requestID is set.
	for _, s := range m.sessions {
		if s.requestID == runID {
			return s.key
		}
	}
	return ""
}

// killProcess sends SIGTERM to a process, then escalates to SIGKILL after 5s
// if the process is still alive.
func killProcess(pid int) {
	if pid <= 0 {
		return
	}
	p, err := findProcess(pid)
	if err != nil || p == nil {
		return
	}
	p.Signal(signalTerm()) //nolint:errcheck // process teardown
	// Escalate to SIGKILL after 5s if the process hasn't exited.
	go func() {
		time.Sleep(5 * time.Second)
		p.Signal(signalKill()) //nolint:errcheck // process teardown
	}()
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func toInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	default:
		return 0
	}
}

func toStringMap(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return nil
}

// telemetryAdapter wraps telemetry.Collector to satisfy backend.TelemetryCollector.
type telemetryAdapter struct {
	c *telemetry.Collector
}

func (a *telemetryAdapter) Event(name string, payload map[string]interface{}, ctx map[string]interface{}) {
	a.c.Event(name, payload, ctx)
}

func (a *telemetryAdapter) StartSpan(name string, attrs map[string]interface{}) backend.Span {
	return a.c.StartSpan(name, attrs)
}

func (a *telemetryAdapter) StartSpanCtx(name string, attrs, ctx map[string]interface{}) backend.Span {
	return a.c.StartSpanCtx(name, attrs, ctx)
}
