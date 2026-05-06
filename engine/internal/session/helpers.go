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
	_ = p.Signal(signalTerm())
	// Escalate to SIGKILL after 5s if the process hasn't exited.
	go func() {
		time.Sleep(5 * time.Second)
		_ = p.Signal(signalKill())
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
