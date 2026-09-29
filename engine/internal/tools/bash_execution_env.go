package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// bashExecutionEnv carries the owning session into local Bash descendants.
// External tools can use the session identity to associate their own work with
// the source conversation without the engine needing to know how a client
// presents that work.
//
// FR-04/generic tool-env mechanism: ToolEnvFromContext's map (RunConfig.ToolEnv,
// stamped by the runloop from every run's resolved value -- see
// WithToolEnv's doc comment) is merged in alongside ION_SESSION_ID. Session
// identity always wins on a key collision: a caller-supplied ToolEnv entry
// or a resolved git identity variable can never override ION_SESSION_ID.
func bashExecutionEnv(ctx context.Context) map[string]string {
	sessionID := utils.SessionIDFromContext(ctx)
	toolEnv := ToolEnvFromContext(ctx)
	if sessionID == "" && len(toolEnv) == 0 {
		return nil
	}
	env := make(map[string]string, len(toolEnv)+1)
	for k, v := range toolEnv {
		env[k] = v
	}
	if sessionID != "" {
		env["ION_SESSION_ID"] = sessionID
	}
	return env
}

type toolEnvKey struct{}

// WithToolEnv returns a context carrying env for local Bash subprocesses.
// Stamped by the runloop from RunConfig.ToolEnv -- the merge of a caller's
// own EngineConfig.ToolEnv (generic, opaque to the engine) with FR-04's
// resolved git author/committer identity (session.resolveGitIdentity),
// computed once per run in buildRunConfig. Consumed by bashExecutionEnv.
func WithToolEnv(ctx context.Context, env map[string]string) context.Context {
	if len(env) == 0 {
		return ctx
	}
	return context.WithValue(ctx, toolEnvKey{}, env)
}

// ToolEnvFromContext extracts the tool-subprocess environment stamped by
// WithToolEnv, or nil.
func ToolEnvFromContext(ctx context.Context) map[string]string {
	env, _ := ctx.Value(toolEnvKey{}).(map[string]string) //nolint:errcheck // absent value means no tool env
	return env
}
