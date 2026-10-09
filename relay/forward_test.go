package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"
)

// TestRewriteTraceparent pins the one byte-level edit the relay makes:
// the span id inside the outer traceparent, and nothing else.
func TestRewriteTraceparent(t *testing.T) {
	const newSpan = "a1b2c3d4e5f60718"
	sealed := `"nonce":"bm9uY2U=","ciphertext":"c2VhbGVkLXN0dWRpby1mcmFtZQ=="`
	for _, tc := range []struct {
		name  string
		frame string
	}{
		{"compact", `{"v":1,` + sealed + `,"traceparent":"` + testTraceparent + `"}`},
		{"spaced", `{ "traceparent" :   "` + testTraceparent + `" , ` + sealed + ` }`},
		{"newlines", "{\n\t\"traceparent\":\n\t\"" + testTraceparent + "\",\n" + sealed + "}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := []byte(tc.frame)
			out, ok := rewriteTraceparent(in, testTraceparent, newSpan)
			if !ok {
				t.Fatalf("not rewritten: %s", in)
			}
			if len(out) != len(in) {
				t.Fatalf("length changed %d -> %d", len(in), len(out))
			}
			want := "00-4bf92f3577b34da6a3ce929d0e0e4736-" + newSpan + "-01"
			if !bytes.Contains(out, []byte(want)) {
				t.Fatalf("new traceparent missing: %s", out)
			}
			if bytes.Contains(out, []byte(testTraceparent)) {
				t.Fatalf("old traceparent still present: %s", out)
			}
			// Everything outside the span id is byte-identical.
			restored := bytes.Replace(out, []byte(want), []byte(testTraceparent), 1)
			if !bytes.Equal(restored, in) {
				t.Fatalf("bytes outside the span id changed:\n got %s\nwant %s", restored, in)
			}
			if !bytes.Contains(out, []byte(sealed)) {
				t.Fatalf("sealed bytes changed: %s", out)
			}
			if bytes.Equal(out, in) || &out[0] == &in[0] {
				t.Fatal("input must be copied, not edited in place")
			}
		})
	}

	// The key must be a key: a string value equal to "traceparent" and a
	// key with a different value are left alone.
	for _, frame := range []string{
		`{"pushBody":"traceparent","x":"` + testTraceparent + `"}`,
		`{"traceparent":"00-ffffffffffffffffffffffffffffffff-00f067aa0ba902b7-01"}`,
		`{}`,
		`not json`,
	} {
		in := []byte(frame)
		out, ok := rewriteTraceparent(in, testTraceparent, newSpan)
		if ok || !bytes.Equal(out, in) {
			t.Fatalf("rewrote %s -> %s (ok=%v)", in, out, ok)
		}
	}
	if _, ok := rewriteTraceparent([]byte(`{"traceparent":"`+testTraceparent+`"}`), testTraceparent, "short"); ok {
		t.Fatal("accepted a span id that is not 16 chars")
	}
}

// TestForwardSpanBothDirectionsFanOut pins a server frame fanned out to two
// clients on a multi-client channel: one span, peers=2, and the slow peer
// is one of the two client ids.
func TestForwardSpanBothDirectionsFanOut(t *testing.T) {
	apiKey := testKey
	col := newOTLPCollector(t)
	s, _ := newTestShipper(t, otlpConfig{Endpoint: col.srv.URL})
	server, hub := startTestRelay(t, apiKey)
	hub.otlp = s
	ion := dialMulti(t, server.URL, "fan-chan")
	time.Sleep(50 * time.Millisecond)
	m1 := dialWS(t, server, "fan-chan", "mobile", apiKey)
	readExpected(t, ion, "peer-joined-1")
	m2 := dialWS(t, server, "fan-chan", "mobile", apiKey)
	readExpected(t, ion, "peer-joined-2")

	frame := []byte(`{"traceparent":"` + testTraceparent + `","ciphertext":"AAAA"}`)
	writeFrame(t, ion, frame)
	got1 := readExpected(t, m1, "fan-1")
	got2 := readExpected(t, m2, "fan-2")
	if !bytes.Equal(got1, got2) {
		t.Fatalf("fan-out frames differ:\n%s\n%s", got1, got2)
	}
	deadline := time.Now().Add(2 * time.Second)
	for s.spans.len() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	spans := s.spans.take(10)
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %d", len(spans))
	}
	a := attrMap(spans[0].Attributes)
	if a["direction"] != "ion_to_mobile" || a["peers"] != "2" {
		t.Fatalf("attrs = %v", a)
	}
	if a["slow_peer"] == "" || a["slow_peer"] == forwardPeerIon || len(a["slow_peer"]) != 12 {
		t.Fatalf("slow_peer = %q", a["slow_peer"])
	}
	if !bytes.Contains(got1, []byte(spans[0].SpanID)) {
		t.Fatalf("fan-out frame does not carry the span id %s: %s", spans[0].SpanID, got1)
	}
	s.Flush(context.Background())
}

// TestForwardWithoutTracingLeavesFrameUntouched pins that with OTLP off
// (no span to record) the traceparent is forwarded as the sender wrote it:
// a span id nobody records would leave a hole in the trace.
func TestForwardWithoutTracingLeavesFrameUntouched(t *testing.T) {
	apiKey := "test-key-untraced"
	server, hub := startTestRelay(t, apiKey)
	if hub.otlp != nil {
		t.Fatal("test relay must start with OTLP off")
	}
	ion := dialWS(t, server, "plain-chan", "ion", apiKey)
	time.Sleep(50 * time.Millisecond)
	mobile := dialWS(t, server, "plain-chan", "mobile", apiKey)
	readExpected(t, ion, "peer-reconnected")

	frame := []byte(`{"seq":3,"traceparent":"` + testTraceparent + `"}`)
	writeFrame(t, mobile, frame)
	if got := readExpected(t, ion, "forwarded"); !bytes.Equal(got, frame) {
		t.Fatalf("frame changed with tracing off:\n got %s\nwant %s", got, frame)
	}
	ack := readExpected(t, mobile, "ack")
	if !strings.Contains(string(ack), "relay:forwarded") {
		t.Fatalf("ack = %s", ack)
	}
}
