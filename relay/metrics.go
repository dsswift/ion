package main

// metrics.go — the relay's Prometheus metrics. One relayMetrics owns one
// registry so a test can build a hub with its own set; the production hub
// gets one from NewHub and serves it on /metrics (routes.go) unless
// RELAY_METRICS_ENABLED=false, in which case hub.metrics is nil. Every
// method is nil-safe so the recording sites stay unconditional.

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Direction labels on frame, byte, and forward metrics.
const (
	directionMobileToIon = "mobile_to_ion"
	directionIonToMobile = "ion_to_mobile"
)

// Outcome labels on relay_apns_seconds.
const apnsOutcomeDelivered = "delivered"

// relayMetrics is every metric the relay exposes. Names are fixed here and
// listed in docs/observability/log-schema.md § "relay".
type relayMetrics struct {
	registry *prometheus.Registry

	connections    *prometheus.GaugeVec     // relay_connections{role}
	frames         *prometheus.CounterVec   // relay_frames_total{direction}
	bytes          *prometheus.CounterVec   // relay_bytes_total{direction}
	forwardSeconds *prometheus.HistogramVec // relay_forward_seconds{direction}
	pingRTT        prometheus.Histogram     // relay_ping_rtt_seconds
	reconnects     *prometheus.CounterVec   // relay_reconnects_total{role}
	authSeconds    *prometheus.HistogramVec // relay_auth_seconds{outcome}
	apnsQueueDepth prometheus.Gauge         // relay_apns_queue_depth
	apnsSeconds    *prometheus.HistogramVec // relay_apns_seconds{outcome}
	apnsDropped    prometheus.Counter       // relay_apns_dropped_total
}

// relayMetricNames is every metric name newRelayMetrics registers, for the
// registration test and the docs.
var relayMetricNames = []string{
	"relay_connections",
	"relay_frames_total",
	"relay_bytes_total",
	"relay_forward_seconds",
	"relay_ping_rtt_seconds",
	"relay_reconnects_total",
	"relay_auth_seconds",
	"relay_apns_queue_depth",
	"relay_apns_seconds",
	"relay_apns_dropped_total",
}

// latencyBuckets covers a LAN hop to a slow mobile network: 1ms to ~16s.
var latencyBuckets = prometheus.ExponentialBuckets(0.001, 2, 15)

// newRelayMetrics builds and registers every relay metric on a fresh
// registry, alongside the Go runtime and process collectors.
func newRelayMetrics() *relayMetrics {
	reg := prometheus.NewRegistry()
	m := &relayMetrics{
		registry: reg,
		connections: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "relay_connections",
			Help: "Open WebSocket connections by role (ion | mobile).",
		}, []string{"role"}),
		frames: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "relay_frames_total",
			Help: "Frames read from a peer by direction, whether or not they were forwarded.",
		}, []string{"direction"}),
		bytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "relay_bytes_total",
			Help: "Frame bytes read from a peer by direction.",
		}, []string{"direction"}),
		forwardSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "relay_forward_seconds",
			Help:    "Time from a frame's receipt to the end of its last peer write, by direction.",
			Buckets: latencyBuckets,
		}, []string{"direction"}),
		pingRTT: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "relay_ping_rtt_seconds",
			Help:    "Keepalive ping round trip: ping sent to pong received.",
			Buckets: latencyBuckets,
		}),
		reconnects: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "relay_reconnects_total",
			Help: "Connections that replaced a live connection of the same role on their channel.",
		}, []string{"role"}),
		authSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "relay_auth_seconds",
			Help:    "Time spent authenticating a channel join, by outcome (success or the failure reason).",
			Buckets: latencyBuckets,
		}, []string{"outcome"}),
		apnsQueueDepth: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "relay_apns_queue_depth",
			Help: "Pushes waiting for the APNs worker.",
		}),
		apnsSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "relay_apns_seconds",
			Help:    "Time from a push's enqueue to the APNs response, by outcome (delivered or the failure reason).",
			Buckets: latencyBuckets,
		}, []string{"outcome"}),
		apnsDropped: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "relay_apns_dropped_total",
			Help: "Pushes refused because the APNs queue was full.",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.connections, m.frames, m.bytes, m.forwardSeconds, m.pingRTT,
		m.reconnects, m.authSeconds, m.apnsQueueDepth, m.apnsSeconds, m.apnsDropped,
	)
	// Pre-create the fixed label sets so a gauge reads 0 rather than being
	// absent before the first event.
	for _, role := range []string{"ion", "mobile"} {
		m.connections.WithLabelValues(role)
		m.reconnects.WithLabelValues(role)
	}
	for _, d := range []string{directionMobileToIon, directionIonToMobile} {
		m.frames.WithLabelValues(d)
		m.bytes.WithLabelValues(d)
		m.forwardSeconds.WithLabelValues(d)
	}
	m.authSeconds.WithLabelValues("success")
	m.apnsSeconds.WithLabelValues(apnsOutcomeDelivered)
	return m
}

// handler serves the registry in the Prometheus text format.
func (m *relayMetrics) handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *relayMetrics) connectionOpened(role string) {
	if m == nil {
		return
	}
	m.connections.WithLabelValues(role).Inc()
}

func (m *relayMetrics) connectionClosed(role string) {
	if m == nil {
		return
	}
	m.connections.WithLabelValues(role).Dec()
}

func (m *relayMetrics) reconnected(role string) {
	if m == nil {
		return
	}
	m.reconnects.WithLabelValues(role).Inc()
}

// frameRead counts one frame read from a peer, forwarded or not.
func (m *relayMetrics) frameRead(direction string, n int) {
	if m == nil {
		return
	}
	m.frames.WithLabelValues(direction).Inc()
	m.bytes.WithLabelValues(direction).Add(float64(n))
}

func (m *relayMetrics) forwarded(direction string, d time.Duration) {
	if m == nil {
		return
	}
	m.forwardSeconds.WithLabelValues(direction).Observe(d.Seconds())
}

func (m *relayMetrics) pingRoundTrip(d time.Duration) {
	if m == nil {
		return
	}
	m.pingRTT.Observe(d.Seconds())
}

// authObserved records one authentication attempt. outcome is "success" or
// the AuthFailureReason, a closed enum.
func (m *relayMetrics) authObserved(outcome string, d time.Duration) {
	if m == nil {
		return
	}
	m.authSeconds.WithLabelValues(outcome).Observe(d.Seconds())
}

func (m *relayMetrics) apnsQueued(depth int) {
	if m == nil {
		return
	}
	m.apnsQueueDepth.Set(float64(depth))
}

func (m *relayMetrics) apnsFinished(outcome string, d time.Duration) {
	if m == nil {
		return
	}
	m.apnsSeconds.WithLabelValues(outcome).Observe(d.Seconds())
}

func (m *relayMetrics) apnsDroppedPush() {
	if m == nil {
		return
	}
	m.apnsDropped.Inc()
}
