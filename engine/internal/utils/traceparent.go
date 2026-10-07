package utils

import (
	"context"
	"strings"
)

// W3C trace-context helpers. A trace spans processes: a client mints the
// trace and its root span, passes `traceparent` to the next hop, and each
// hop records its own spans as children. These helpers validate and move
// the two identifiers the engine needs: the trace-id (32 hex) and the
// parent span-id (16 hex).

const (
	traceIDHexLen = 32
	spanIDHexLen  = 16
)

// IsValidTraceID reports whether id is a W3C trace-id: 32 lowercase hex
// characters, not all zero.
func IsValidTraceID(id string) bool {
	return isLowerHexID(id, traceIDHexLen)
}

// IsValidSpanID reports whether id is a W3C span-id: 16 lowercase hex
// characters, not all zero.
func IsValidSpanID(id string) bool {
	return isLowerHexID(id, spanIDHexLen)
}

func isLowerHexID(id string, n int) bool {
	if len(id) != n || strings.Trim(id, "0") == "" {
		return false
	}
	for _, r := range id {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// NewSpanID returns a fresh W3C span-id (16 lowercase hex characters).
func NewSpanID() string {
	return RandomID()
}

// ParseTraceparent parses a W3C `traceparent` header value
// (`00-<trace-id>-<parent-id>-<flags>`). ok is false for any value that is
// not version 00 with a valid trace-id and span-id; callers mint their own
// trace in that case.
func ParseTraceparent(value string) (traceID, spanID string, ok bool) {
	parts := strings.Split(strings.TrimSpace(value), "-")
	if len(parts) != 4 || parts[0] != "00" || len(parts[3]) != 2 {
		return "", "", false
	}
	if !IsValidTraceID(parts[1]) || !IsValidSpanID(parts[2]) {
		return "", "", false
	}
	return parts[1], parts[2], true
}

// FormatTraceparent renders a sampled W3C `traceparent` value.
func FormatTraceparent(traceID, spanID string) string {
	return "00-" + traceID + "-" + spanID + "-01"
}

// WithSpanID returns a context carrying the span-id of the span that
// encloses work done under it. Spans started under this context are its
// children.
func WithSpanID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKeySpanID, id)
}

// SpanIDFromContext returns the enclosing span-id carried by ctx, or "".
func SpanIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeySpanID).(string); ok {
		return v
	}
	return ""
}

// TraceparentFromContext renders the trace position ctx carries (its
// trace-id and the enclosing span-id) as a sampled W3C `traceparent` value
// for an outbound hop: a provider request header, a delegated CLI's or MCP
// server's TRACEPARENT environment variable. Returns "" when ctx carries no
// valid pair, so the hop sends nothing rather than a malformed value.
func TraceparentFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	traceID, spanID := TraceIDFromContext(ctx), SpanIDFromContext(ctx)
	if !IsValidTraceID(traceID) || !IsValidSpanID(spanID) {
		return ""
	}
	return FormatTraceparent(traceID, spanID)
}
