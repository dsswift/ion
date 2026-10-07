package main

// otlp_traces.go — relay.forward spans. A forwarded frame whose outer
// envelope carries a W3C traceparent gets one span, parented to the
// traceparent's span, running from the previous frame boundary (the start
// of the read) to the last peer write. The span's id is minted before the
// write so forward.go can put it on the wire in the traceparent's span-id
// slot; the sealed payload is never touched.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"time"
)

// traceContext is a parsed W3C traceparent.
type traceContext struct {
	TraceID string // 32 lowercase hex
	SpanID  string // 16 lowercase hex, the parent of the span the relay records
}

// parseTraceparent accepts version-00 traceparents only:
// 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>, lowercase, with
// non-zero trace and span ids.
func parseTraceparent(v string) (traceContext, bool) {
	if len(v) != 55 || v[0:3] != "00-" || v[35] != '-' || v[52] != '-' {
		return traceContext{}, false
	}
	traceID, spanID, flags := v[3:35], v[36:52], v[53:55]
	if !isValidTraceID(traceID) || !isValidSpanID(spanID) || !isLowerHex(flags) {
		return traceContext{}, false
	}
	return traceContext{TraceID: traceID, SpanID: spanID}, true
}

// isValidTraceID reports whether id is a W3C trace id: 32 lowercase hex,
// not all zero.
func isValidTraceID(id string) bool {
	return len(id) == 32 && isLowerHex(id) && !isAllZero(id)
}

// isValidSpanID reports whether id is a W3C span id: 16 lowercase hex, not
// all zero.
func isValidSpanID(id string) bool {
	return len(id) == 16 && isLowerHex(id) && !isAllZero(id)
}

func isLowerHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func isAllZero(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] != '0' {
			return false
		}
	}
	return true
}

// newSpanID returns a random non-zero 16-hex span id.
func newSpanID() (string, error) {
	var b [8]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		if b != [8]byte{} {
			return hex.EncodeToString(b[:]), nil
		}
	}
}

// --- OTLP traces wire types ---

type otlpTracesRequest struct {
	ResourceSpans []otlpResourceSpans `json:"resourceSpans"`
}

type otlpResourceSpans struct {
	Resource   otlpResource     `json:"resource"`
	ScopeSpans []otlpScopeSpans `json:"scopeSpans"`
}

type otlpScopeSpans struct {
	Scope otlpScope  `json:"scope"`
	Spans []otlpSpan `json:"spans"`
}

// OTLP span kind and status codes.
const (
	otlpSpanKindServer = 2
	otlpStatusUnset    = 0
	otlpStatusError    = 2
)

type otlpSpan struct {
	TraceID           string         `json:"traceId"`
	SpanID            string         `json:"spanId"`
	ParentSpanID      string         `json:"parentSpanId"`
	Name              string         `json:"name"`
	Kind              int            `json:"kind"`
	StartTimeUnixNano string         `json:"startTimeUnixNano"`
	EndTimeUnixNano   string         `json:"endTimeUnixNano"`
	Attributes        []otlpAttr     `json:"attributes"`
	Status            otlpSpanStatus `json:"status"`
}

type otlpSpanStatus struct {
	Code    int    `json:"code"`
	Message string `json:"message,omitempty"`
}

// forwardSpan describes one forwarded frame for recordForward.
type forwardSpan struct {
	SpanID    string // the span's own id, already on the wire
	Parent    traceContext
	Start     time.Time // the previous frame boundary: when the read began
	End       time.Time // after the last peer write
	Direction string    // "mobile_to_ion" | "ion_to_mobile"
	ChannelID string
	Seq       int64 // outer envelope seq; 0 when absent
	Bytes     int
	// ReadTime is read start to frame received; WriteTime is the whole write
	// phase; PeerWriteTime is the slowest single peer write and SlowPeer that
	// peer's id ("ion" for the server). Peers is how many were written.
	ReadTime      time.Duration
	WriteTime     time.Duration
	Peers         int
	PeerWriteTime time.Duration
	SlowPeer      string
	WriteErr      error
}

// forwardDirection names the direction of a frame read from role.
func forwardDirection(role string) string {
	if role == "mobile" {
		return "mobile_to_ion"
	}
	return "ion_to_mobile"
}

// tracing reports whether forward spans are being collected.
func (s *otlpShipper) tracing() bool { return s != nil }

// recordForward queues a relay.forward span under f.SpanID. It returns
// false when no span was queued (shipping disabled, or no span id).
func (s *otlpShipper) recordForward(f forwardSpan) bool {
	if s == nil {
		return false
	}
	if !isValidSpanID(f.SpanID) {
		s.local.Warn("otlp: forward span has no valid span id; span dropped", "tag", "relay.otlp", "span_id", f.SpanID)
		return false
	}
	attrs := []otlpAttr{
		{Key: "bytes", Value: otlpInt64(int64(f.Bytes))},
		{Key: "direction", Value: otlpString(f.Direction)},
		{Key: "read_ms", Value: otlpNumber(durationMS(f.ReadTime))},
		{Key: "write_ms", Value: otlpNumber(durationMS(f.WriteTime))},
		{Key: "peers", Value: otlpInt64(int64(f.Peers))},
		{Key: "peer_write_ms", Value: otlpNumber(durationMS(f.PeerWriteTime))},
	}
	if f.SlowPeer != "" {
		attrs = append(attrs, otlpAttr{Key: "slow_peer", Value: otlpString(f.SlowPeer)})
	}
	if f.ChannelID != "" {
		attrs = append(attrs, otlpAttr{Key: "channel_id", Value: otlpString(f.ChannelID)})
	}
	if f.Seq > 0 {
		attrs = append(attrs, otlpAttr{Key: "seq", Value: otlpInt64(f.Seq)})
	}
	status := otlpSpanStatus{Code: otlpStatusUnset}
	if f.WriteErr != nil {
		status = otlpSpanStatus{Code: otlpStatusError, Message: f.WriteErr.Error()}
	}
	s.spans.push(otlpSpan{
		TraceID:      f.Parent.TraceID,
		SpanID:       f.SpanID,
		ParentSpanID: f.Parent.SpanID,
		Name:         "relay.forward",
		// The relay answers the peer that sent the frame, so the forward is a
		// server span: the sender's client span draws an edge to the relay.
		Kind:              otlpSpanKindServer,
		StartTimeUnixNano: strconv.FormatInt(f.Start.UnixNano(), 10),
		EndTimeUnixNano:   strconv.FormatInt(f.End.UnixNano(), 10),
		Attributes:        attrs,
		Status:            status,
	})
	return true
}

// durationMS is d in milliseconds with microsecond precision, the unit the
// span attributes and log lines share.
func durationMS(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

// buildTracesPayload renders a batch of spans as an OTLP/HTTP JSON
// ExportTraceServiceRequest.
func (s *otlpShipper) buildTracesPayload(spans []otlpSpan) ([]byte, error) {
	return json.Marshal(otlpTracesRequest{
		ResourceSpans: []otlpResourceSpans{{
			Resource: otlpResource{Attributes: s.otlpResourceAttrs()},
			ScopeSpans: []otlpScopeSpans{{
				Scope: otlpScope{Name: otlpServiceName},
				Spans: spans,
			}},
		}},
	})
}
