package tools

import "context"

// task_tools_available.go answers one question for the Bash tool: can the model
// that made this call reach TaskGet and TaskStop?
//
// The answer used to be a probe of the global registry (GetTool("TaskGet")),
// which is correct only when the model's tool list IS the global registry. That
// holds for an API run and fails for a delegated-CLI run, where the engine's
// task tools are bridged to the subprocess over MCP without ever entering the
// global registry — they are harness opt-in there (optional.go) and must stay
// that way, because registering them globally would hand them to every API run
// on the machine as a side effect of wiring one CLI session.
//
// So the availability travels on the context, stamped by whichever layer wired
// the tools, and the registry probe remains the fallback for callers that
// stamped nothing.

type taskToolsAvailableKey struct{}

// WithTaskToolsAvailable marks the tool context as one whose model can call
// TaskGet and TaskStop. Stamped by the delegated-CLI wiring, which registers
// those tools on the session's MCP ToolServer rather than in the global
// registry.
func WithTaskToolsAvailable(ctx context.Context) context.Context {
	return context.WithValue(ctx, taskToolsAvailableKey{}, true)
}

// TaskToolsAvailable reports whether the calling model can reach the task
// tools. An unstamped context falls back to the global registry, which is the
// authoritative answer for an API run.
func TaskToolsAvailable(ctx context.Context) bool {
	// The discarded ok is the "not stamped" case, which is not a failure: an
	// absent (or wrongly-typed) value yields false and falls through to the
	// registry probe below, which is the authoritative answer for an API run.
	// errcheck runs with check-blank, so the discard is declared rather than
	// silent.
	if stamped, _ := ctx.Value(taskToolsAvailableKey{}).(bool); stamped { //nolint:errcheck // absent value means "not stamped"; the registry fallback below handles it
		return true
	}
	return GetTool("TaskGet") != nil
}
