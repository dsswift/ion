package extension

import "testing"

// TestSetTelemetrySinkNilSafety verifies the telemetry-sink setter is safe to
// call with nil (the default for sessions without a telemetry collector) and
// with a real func, and that the value round-trips onto the host under notifMu.
// The emission path that consumes telemFn is wired in a later commit; this pins
// the additive setter plumbing in isolation.
func TestSetTelemetrySinkNilSafety(t *testing.T) {
	h := &Host{name: "ext-under-test"}

	// Nil sink is the default and must not panic.
	h.SetTelemetrySink(nil)
	h.notifMu.RLock()
	nilFn := h.telemFn
	h.notifMu.RUnlock()
	if nilFn != nil {
		t.Fatal("SetTelemetrySink(nil) should leave telemFn nil")
	}

	// A real sink round-trips onto the host.
	called := false
	h.SetTelemetrySink(func(event string, payload, ctx map[string]any) { called = true })
	h.notifMu.RLock()
	setFn := h.telemFn
	h.notifMu.RUnlock()
	if setFn == nil {
		t.Fatal("SetTelemetrySink(fn) should set telemFn")
	}
	setFn("x", nil, nil)
	if !called {
		t.Fatal("stored telemFn did not invoke the provided func")
	}
}
