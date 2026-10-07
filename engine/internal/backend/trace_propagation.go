package backend

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// traceparentEnvKey is the environment variable a delegated process (a
// delegated CLI, an ACP agent, an MCP stdio server) reads to join the
// engine's trace. Its value is the W3C traceparent of the run that spawned
// the process: the run's trace-id and the run span as parent.
const traceparentEnvKey = "TRACEPARENT"

// withTraceparentEnv appends TRACEPARENT to env when ctx carries a trace
// position, and returns env unchanged otherwise. tag names the spawning
// backend in the log line either way.
func withTraceparentEnv(env []string, ctx context.Context, tag string) []string {
	traceparent := utils.TraceparentFromContext(ctx)
	if traceparent == "" {
		utils.LogWithFields(utils.LevelDebug, tag, "spawn carries no trace; TRACEPARENT omitted", nil)
		return env
	}
	utils.LogWithFields(utils.LevelDebug, tag, "TRACEPARENT set for spawned process", map[string]any{"traceparent": traceparent})
	return append(env, traceparentEnvKey+"="+traceparent)
}

// spawnSessionID returns the session key a spawned backend process serves,
// read from the spawning run's context, or "" when the context is nil or
// carries none. System Metrics attributes the process to that session.
func spawnSessionID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	return utils.SessionIDFromContext(ctx)
}

// withLlmCallSpan makes span the enclosing span of ctx, so a provider request
// made under ctx sends traceparent 00-<trace>-<llm.call span>-01 and the
// provider's own spans nest under the engine's llm.call. A span that does
// not expose its id (a test double, or nil when telemetry is disabled)
// leaves ctx unchanged: the request then names the run span, the next
// enclosing one.
func withLlmCallSpan(ctx context.Context, span Span) context.Context {
	ids, ok := span.(interface{ SpanID() string })
	if !ok || ids.SpanID() == "" {
		return ctx
	}
	return utils.WithSpanID(ctx, ids.SpanID())
}
