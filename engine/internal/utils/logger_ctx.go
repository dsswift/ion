package utils

import "context"

// Context keys for correlation IDs. Unexported; callers use the With* helpers.
type contextKey int

const (
	ctxKeySessionID contextKey = iota
	ctxKeyConversationID
	ctxKeyTraceID
)

// WithSessionID returns a new context carrying the given session ID.
func WithSessionID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKeySessionID, id)
}

// WithConversationID returns a new context carrying the given conversation ID.
func WithConversationID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKeyConversationID, id)
}

// WithTraceID returns a new context carrying the given trace ID.
func WithTraceID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, ctxKeyTraceID, id)
}

// SessionIDFromContext returns the session ID carried by ctx, or "" if absent.
func SessionIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeySessionID).(string); ok {
		return v
	}
	return ""
}

// ConversationIDFromContext returns the conversation ID carried by ctx, or ""
// if absent.
func ConversationIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyConversationID).(string); ok {
		return v
	}
	return ""
}

// TraceIDFromContext returns the trace ID carried by ctx, or "" if absent.
func TraceIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKeyTraceID).(string); ok {
		return v
	}
	return ""
}

// LogCtx logs at the given level, threading session_id/conversation_id/trace_id
// from ctx into the log line as top-level correlation attributes when present.
// fields is optional structured context (nil = {}).
func LogCtx(ctx context.Context, level LogLevel, tag, msg string, fields map[string]any) {
	var sessionID, conversationID, traceID string
	if v, ok := ctx.Value(ctxKeySessionID).(string); ok && v != "" {
		sessionID = v
	}
	if v, ok := ctx.Value(ctxKeyConversationID).(string); ok && v != "" {
		conversationID = v
	}
	if v, ok := ctx.Value(ctxKeyTraceID).(string); ok && v != "" {
		traceID = v
	}
	logAtFull(level, "engine", tag, msg, fields, sessionID, conversationID, traceID)
}

// LogExtension writes a structured log line with component="extension" and the
// given correlation IDs. Used by the extension host to forward SDK log
// notifications without losing structured fields. tag MUST be the extension
// name per the log schema. fields is preserved verbatim (nil = {}).
func LogExtension(level LogLevel, tag, msg string, fields map[string]any, sessionID, conversationID string) {
	logAtFull(level, "extension", tag, msg, fields, sessionID, conversationID, "")
}
