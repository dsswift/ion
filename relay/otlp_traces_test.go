package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

func TestParseTraceparent(t *testing.T) {
	tc, ok := parseTraceparent(testTraceparent)
	if !ok || tc.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || tc.SpanID != "00f067aa0ba902b7" {
		t.Fatalf("valid traceparent parsed as %+v ok=%v", tc, ok)
	}
	for _, bad := range []string{
		"",
		"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",  // unknown version
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",  // uppercase
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",  // zero trace id
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",  // zero span id
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0x",  // bad flags
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-010", // too long
		"00_4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",  // bad separator
	} {
		if _, ok := parseTraceparent(bad); ok {
			t.Fatalf("accepted invalid traceparent %q", bad)
		}
	}
}

// startTracedRelay starts a relay whose hub records spans into a shipper
// pointed at a fake collector.
func startTracedRelay(t *testing.T) (*otlpShipper, *otlpCollector, *websocket.Conn, *websocket.Conn) {
	t.Helper()
	apiKey := "test-key-trace"
	col := newOTLPCollector(t)
	s, _ := newTestShipper(t, otlpConfig{Endpoint: col.srv.URL})
	server, hub := startTestRelay(t, apiKey)
	hub.otlp = s
	ion := dialWS(t, server, "trace-chan", "ion", apiKey)
	time.Sleep(50 * time.Millisecond)
	mobile := dialWS(t, server, "trace-chan", "mobile", apiKey)
	// The ion side hears the mobile connect.
	readExpected(t, ion, "peer-reconnected")
	return s, col, ion, mobile
}

func writeFrame(t *testing.T, conn *websocket.Conn, frame []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestForwardSpanParentedFromTraceparent(t *testing.T) {
	s, col, ion, mobile := startTracedRelay(t)

	// Unusual spacing and key order: the forwarded bytes must match exactly.
	frame := []byte(`{ "seq":7,"traceparent":"` + testTraceparent + `",  "ciphertext":"AAAA" }`)
	writeFrame(t, mobile, frame)
	if got := readExpected(t, ion, "forwarded"); !bytes.Equal(got, frame) {
		t.Fatalf("forwarded bytes changed:\n got %s\nwant %s", got, frame)
	}
	readExpected(t, mobile, "ack")

	back := []byte(`{"traceparent":"` + testTraceparent + `","payload":"x"}`)
	writeFrame(t, ion, back)
	if got := readExpected(t, mobile, "forwarded-back"); !bytes.Equal(got, back) {
		t.Fatalf("forwarded bytes changed:\n got %s\nwant %s", got, back)
	}

	// The span is queued just after the peer write, so the reader can win.
	deadline := time.Now().Add(2 * time.Second)
	for s.spans.len() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	s.Flush(context.Background())
	reqs := col.requests()
	if len(reqs) != 1 || reqs[0].Path != "/v1/traces" {
		t.Fatalf("want one /v1/traces request, got %+v", reqs)
	}
	var req otlpTracesRequest
	if err := json.Unmarshal(reqs[0].Body, &req); err != nil {
		t.Fatal(err)
	}
	res := attrMap(req.ResourceSpans[0].Resource.Attributes)
	if res["service.name"] != "ion-relay" || res["host.name"] != s.host || res["service.namespace"] != "ion" ||
		res["service.instance.id"] != s.host || res["service.version"] != relayVersion || relayVersion == "" {
		t.Fatalf("resource = %v", res)
	}
	spans := req.ResourceSpans[0].ScopeSpans[0].Spans
	if len(spans) != 2 {
		t.Fatalf("want 2 spans, got %d", len(spans))
	}
	for i, sp := range spans {
		if sp.Name != "relay.forward" || sp.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || sp.ParentSpanID != "00f067aa0ba902b7" {
			t.Fatalf("span %d not parented to the traceparent: %+v", i, sp)
		}
		if len(sp.SpanID) != 16 || !isLowerHex(sp.SpanID) || sp.SpanID == sp.ParentSpanID {
			t.Fatalf("span %d id %q", i, sp.SpanID)
		}
		start, errS := strconv.ParseInt(sp.StartTimeUnixNano, 10, 64)
		end, errE := strconv.ParseInt(sp.EndTimeUnixNano, 10, 64)
		if errS != nil || errE != nil || start == 0 || end < start {
			t.Fatalf("span %d times %s..%s", i, sp.StartTimeUnixNano, sp.EndTimeUnixNano)
		}
		if sp.Status.Code != otlpStatusUnset {
			t.Fatalf("span %d status %+v", i, sp.Status)
		}
		// A server span: the sender's client span is its parent, so a trace
		// backend draws an edge from the sender to the relay.
		if sp.Kind != otlpSpanKindServer {
			t.Fatalf("span %d kind = %d, want server", i, sp.Kind)
		}
	}
	up := attrMap(spans[0].Attributes)
	if up["direction"] != "mobile_to_ion" || up["channel_id"] != "trace-chan" || up["seq"] != "7" || up["bytes"] != strconv.Itoa(len(frame)) {
		t.Fatalf("mobile span attrs = %v (frame %d bytes)", up, len(frame))
	}
	down := attrMap(spans[1].Attributes)
	if down["direction"] != "ion_to_mobile" || down["channel_id"] != "trace-chan" || down["seq"] != "" {
		t.Fatalf("ion span attrs = %v", down)
	}
	if spans[0].SpanID == spans[1].SpanID {
		t.Fatal("span ids must be unique")
	}
}

func TestForwardInvalidTraceparentRecordsNoSpan(t *testing.T) {
	s, col, ion, mobile := startTracedRelay(t)

	for _, frame := range [][]byte{
		[]byte(`{"seq":1,"traceparent":"00-not-a-trace-01"}`),
		[]byte(`{"seq":2}`),
		[]byte(`not json at all`),
	} {
		writeFrame(t, mobile, frame)
		if got := readExpected(t, ion, "forwarded"); !bytes.Equal(got, frame) {
			t.Fatalf("forwarded bytes changed:\n got %s\nwant %s", got, frame)
		}
	}
	if n := s.spans.len(); n != 0 {
		t.Fatalf("recorded %d spans for frames without a valid traceparent", n)
	}
	s.Flush(context.Background())
	if n := len(col.requests()); n != 0 {
		t.Fatalf("made %d export calls with nothing to ship", n)
	}
}

// A relay log line that names a trace carries it as the OTLP LogRecord
// traceId (and spanId when the line names a span), where Application
// Insights reads a log's operation, and no attribute repeats either id.
func TestOTLPLogRecordCarriesTraceAndSpanIDs(t *testing.T) {
	s, _ := newTestShipper(t, otlpConfig{Endpoint: "http://collector.invalid"})
	const trace, span = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"
	with := s.otlpLogRecordFromLine([]byte(`{"ts":"2026-09-23T10:00:01Z","level":"INFO","component":"relay","tag":"relay.forward","trace_id":"` + trace + `","fields":{"span_id":"` + span + `"}}`))
	if with.TraceID != trace || with.SpanID != span {
		t.Fatalf("record = %+v", with)
	}
	if a := attrMap(with.Attributes); a["trace_id"] != "" || a["span_id"] != "" {
		t.Fatalf("ids repeated as attributes: %v", a)
	}
	bad := s.otlpLogRecordFromLine([]byte(`{"ts":"2026-09-23T10:00:01Z","level":"INFO","component":"relay","trace_id":"not-a-trace","fields":{"span_id":"` + span + `"}}`))
	if bad.TraceID != "" || bad.SpanID != "" {
		t.Fatalf("invalid trace kept: %+v", bad)
	}
	raw, err := json.Marshal(s.otlpLogRecordFromLine([]byte(`{"level":"INFO","component":"relay"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"traceId"`)) || bytes.Contains(raw, []byte(`"spanId"`)) {
		t.Fatalf("empty ids serialized: %s", raw)
	}
}
