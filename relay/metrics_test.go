package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
)

// gatherFamilies reads every metric family off a hub's registry by name.
func gatherFamilies(t *testing.T, m *relayMetrics) map[string]*dto.MetricFamily {
	t.Helper()
	fams, err := m.registry.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	out := make(map[string]*dto.MetricFamily, len(fams))
	for _, f := range fams {
		out[f.GetName()] = f
	}
	return out
}

func histogramCount(f *dto.MetricFamily, label, value string) uint64 {
	if f == nil {
		return 0
	}
	for _, m := range f.GetMetric() {
		if label == "" {
			return m.GetHistogram().GetSampleCount()
		}
		for _, l := range m.GetLabel() {
			if l.GetName() == label && l.GetValue() == value {
				return m.GetHistogram().GetSampleCount()
			}
		}
	}
	return 0
}

func counterValue(f *dto.MetricFamily, label, value string) float64 {
	if f == nil {
		return 0
	}
	for _, m := range f.GetMetric() {
		for _, l := range m.GetLabel() {
			if l.GetName() == label && l.GetValue() == value {
				if m.Counter != nil {
					return m.GetCounter().GetValue()
				}
				return m.GetGauge().GetValue()
			}
		}
	}
	return 0
}

// TestMetricsRegistration pins that every documented relay metric is
// registered and that a forwarded frame, traced or not, is observed.
func TestMetricsRegistration(t *testing.T) {
	apiKey := "test-key-metrics"
	server, hub := startTestRelay(t, apiKey)
	fams := gatherFamilies(t, hub.metrics)
	for _, name := range relayMetricNames {
		if _, ok := fams[name]; !ok {
			t.Errorf("metric %s not registered", name)
		}
	}
	if _, ok := fams["go_goroutines"]; !ok {
		t.Error("Go runtime collector not registered")
	}

	ion := dialWS(t, server, "metrics-chan", "ion", apiKey)
	time.Sleep(50 * time.Millisecond)
	mobile := dialWS(t, server, "metrics-chan", "mobile", apiKey)
	readExpected(t, ion, "peer-reconnected")

	fams = gatherFamilies(t, hub.metrics)
	if got := counterValue(fams["relay_connections"], "role", "ion"); got != 1 {
		t.Fatalf("relay_connections{role=ion} = %v, want 1", got)
	}
	if got := counterValue(fams["relay_connections"], "role", "mobile"); got != 1 {
		t.Fatalf("relay_connections{role=mobile} = %v, want 1", got)
	}

	// No traceparent: no span, but every counter and the histogram move.
	frame := []byte(`{"seq":1,"ciphertext":"AAAA"}`)
	writeFrame(t, mobile, frame)
	readExpected(t, ion, "forwarded")
	readExpected(t, mobile, "ack")
	writeFrame(t, ion, []byte(`{"payload":"x"}`))
	readExpected(t, mobile, "forwarded-back")

	fams = gatherFamilies(t, hub.metrics)
	if got := counterValue(fams["relay_frames_total"], "direction", directionMobileToIon); got != 1 {
		t.Fatalf("relay_frames_total{mobile_to_ion} = %v", got)
	}
	if got := counterValue(fams["relay_frames_total"], "direction", directionIonToMobile); got != 1 {
		t.Fatalf("relay_frames_total{ion_to_mobile} = %v", got)
	}
	if got := counterValue(fams["relay_bytes_total"], "direction", directionMobileToIon); got != float64(len(frame)) {
		t.Fatalf("relay_bytes_total{mobile_to_ion} = %v, want %d", got, len(frame))
	}
	if got := histogramCount(fams["relay_forward_seconds"], "direction", directionMobileToIon); got != 1 {
		t.Fatalf("relay_forward_seconds{mobile_to_ion} count = %d", got)
	}
	if got := histogramCount(fams["relay_forward_seconds"], "direction", directionIonToMobile); got != 1 {
		t.Fatalf("relay_forward_seconds{ion_to_mobile} count = %d", got)
	}

	// A second ion join replaces the first: one reconnect. The replaced
	// connection is read until it closes so the graceful close completes.
	go func() {
		for {
			if _, _, err := ion.Read(context.Background()); err != nil {
				return
			}
		}
	}()
	ion2 := dialWS(t, server, "metrics-chan", "ion", apiKey)
	readExpected(t, mobile, "peer-reconnected")
	time.Sleep(50 * time.Millisecond)
	fams = gatherFamilies(t, hub.metrics)
	if got := counterValue(fams["relay_reconnects_total"], "role", "ion"); got != 1 {
		t.Fatalf("relay_reconnects_total{ion} = %v", got)
	}
	ion2.CloseNow()
}

// TestMetricsRouteServedAndOptional pins the /metrics route on the
// production mux, present with a registry and absent without one.
func TestMetricsRouteServedAndOptional(t *testing.T) {
	hub := NewHub()
	auth := NewAuthMiddleware("k", nil)
	srv := httptest.NewServer(newRelayMux(hub, auth, newChannelOwnerStore(""), nil))
	t.Cleanup(srv.Close)
	resp, err := http.Get(srv.URL + metricsPath)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics = %d", resp.StatusCode)
	}
	for _, name := range relayMetricNames {
		if !strings.Contains(string(body), "# HELP "+name+" ") {
			t.Errorf("/metrics lacks %s", name)
		}
	}

	// Auth timing is observed on a channel join attempt.
	bad, err := http.Get(srv.URL + "/v1/channel/abc123?role=ion")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	fams := gatherFamilies(t, hub.metrics)
	if got := histogramCount(fams["relay_auth_seconds"], "outcome", string(authFailureMissingAuthorization)); got != 1 {
		t.Fatalf("relay_auth_seconds{missing_authorization} count = %d", got)
	}

	off := NewHub()
	off.metrics = nil
	offSrv := httptest.NewServer(newRelayMux(off, auth, newChannelOwnerStore(""), nil))
	t.Cleanup(offSrv.Close)
	resp, err = http.Get(offSrv.URL + metricsPath)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /metrics with metrics off = %d, want 404", resp.StatusCode)
	}
}

// TestMetricsNilSafe pins that a hub with metrics disabled records nothing
// and panics nowhere.
func TestMetricsNilSafe(t *testing.T) {
	var m *relayMetrics
	m.connectionOpened("ion")
	m.connectionClosed("ion")
	m.reconnected("ion")
	m.frameRead(directionIonToMobile, 1)
	m.forwarded(directionIonToMobile, time.Millisecond)
	m.pingRoundTrip(time.Millisecond)
	m.authObserved("success", time.Millisecond)
	m.apnsQueued(1)
	m.apnsFinished(apnsOutcomeDelivered, time.Millisecond)
	m.apnsDroppedPush()
}
