package utils

import (
	"context"
	"testing"
)

func TestParseTraceparent(t *testing.T) {
	const trace = "4bf92f3577b34da6a3ce929d0e0e4736"
	const span = "00f067aa0ba902b7"
	cases := []struct {
		name  string
		value string
		ok    bool
	}{
		{"valid", "00-" + trace + "-" + span + "-01", true},
		{"valid unsampled", "00-" + trace + "-" + span + "-00", true},
		{"surrounding space", "  00-" + trace + "-" + span + "-01 ", true},
		{"empty", "", false},
		{"unknown version", "01-" + trace + "-" + span + "-01", false},
		{"zero trace", "00-00000000000000000000000000000000-" + span + "-01", false},
		{"zero span", "00-" + trace + "-0000000000000000-01", false},
		{"uppercase", "00-4BF92F3577B34DA6A3CE929D0E0E4736-" + span + "-01", false},
		{"short span", "00-" + trace + "-00f067aa-01", false},
		{"missing flags", "00-" + trace + "-" + span, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotTrace, gotSpan, ok := ParseTraceparent(tc.value)
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if ok && (gotTrace != trace || gotSpan != span) {
				t.Errorf("got (%q, %q), want (%q, %q)", gotTrace, gotSpan, trace, span)
			}
		})
	}
}

func TestFormatTraceparentRoundTrips(t *testing.T) {
	trace, span := NewTraceID(), NewSpanID()
	gotTrace, gotSpan, ok := ParseTraceparent(FormatTraceparent(trace, span))
	if !ok || gotTrace != trace || gotSpan != span {
		t.Fatalf("round trip = (%q, %q, %v), want (%q, %q, true)", gotTrace, gotSpan, ok, trace, span)
	}
}

func TestSpanIDContext(t *testing.T) {
	ctx := WithSpanID(context.Background(), "00f067aa0ba902b7")
	if got := SpanIDFromContext(ctx); got != "00f067aa0ba902b7" {
		t.Errorf("SpanIDFromContext = %q", got)
	}
	if got := SpanIDFromContext(context.Background()); got != "" {
		t.Errorf("SpanIDFromContext(empty) = %q, want empty", got)
	}
}

func TestTraceparentFromContext(t *testing.T) {
	const trace = "4bf92f3577b34da6a3ce929d0e0e4736"
	const span = "00f067aa0ba902b7"
	ctx := WithSpanID(WithTraceID(context.Background(), trace), span)
	if got, want := TraceparentFromContext(ctx), "00-"+trace+"-"+span+"-01"; got != want {
		t.Errorf("traceparent = %q, want %q", got, want)
	}
	for name, ctx := range map[string]context.Context{
		"nil":          nil,
		"empty":        context.Background(),
		"trace only":   WithTraceID(context.Background(), trace),
		"invalid span": WithSpanID(WithTraceID(context.Background(), trace), "nope"),
	} {
		if got := TraceparentFromContext(ctx); got != "" {
			t.Errorf("%s: traceparent = %q, want empty", name, got)
		}
	}
}
