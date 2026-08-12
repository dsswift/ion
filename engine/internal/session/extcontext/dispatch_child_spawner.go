package extcontext

import (
	"context"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildChildAgentSpawner returns a tools.AgentSpawner closure suitable for
// wiring onto a dispatched child's RunConfig.AgentSpawner. When the child's
// LLM invokes the engine Agent tool, the runloop extracts this spawner from
// the RunConfig (runloop_tools.go:35-53) and runs it. Without this, the
// child's RunConfig.AgentSpawner is nil and the Agent tool returns the opaque
// "Agent tool not available (no API backend configured)" error.
//
// The spawner delegates to BuildDispatchAgentFunc (the same engine-native
// dispatch infrastructure used by extension ctx.DispatchAgent), wrapping its
// DispatchAgentOpts interface into the tools.AgentSpawner signature. The
// dispatch uses default asynchronous behavior. An explicit wait_for_completion
// input is the only path that blocks for terminal child output.
//
// Why not extract wireAgentSpawner (prompt_agent_spawner.go)? That function
// is tightly coupled to *Manager internals: m.resolveAgentSpec fires
// capability_match hooks through extension hosts, m.emit routes to a session
// key, s.agentCounter is a session-level mutable, s.agents is the agent
// state store, and m.bumpParentProgress pokes the run-progress watchdog.
// Parameterizing all of those behind SessionAccessor would require adding 5+
// methods to the interface for a single consumer. BuildDispatchAgentFunc
// already handles depth guards, dispatch registry, agent state, telemetry,
// and child backend creation through the existing SessionAccessor contract,
// so reuse at that layer is both simpler and more correct.
//
// Depth enforcement: the returned spawner creates grandchildren at
// childDepth+1. The depth guard inside BuildDispatchAgentFunc (dispatch_agent.go
// line 37-45) enforces maxDispatchDepth, so a depth-2 agent's 4th-tier
// dispatch returns a structured depth-cap result without launching a child.
func BuildChildAgentSpawner(
	sa SessionAccessor,
	registry *DispatchRegistry,
	childDepth int,
	childDispatchId string,
) tools.AgentSpawner {
	// Build the dispatch function for this child's depth. When the child
	// invokes the Agent tool, the grandchild will be at childDepth+1.
	dispatchFn := BuildDispatchAgentFunc(sa, registry, childDepth, childDispatchId)

	utils.LogWithFields(utils.LevelInfo, "server", "child spawner wired", map[string]any{"child_depth": childDepth, "child_dispatch_id": childDispatchId, "session_key": sa.SessionKey()})

	return func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		// Map Agent tool inputs to DispatchAgentOpts. Dispatch returns an
		// acknowledgement by default; wait_for_completion is explicit.
		//
		// Log nested working-directory resolution for observability.
		utils.LogWithFields(utils.LevelDebug, "server", "child spawner dispatch", map[string]any{"model": name, "cwd": cwd, "child_dispatch_id": childDispatchId, "child_depth": childDepth, "session_key": sa.SessionKey()})
		//
		// AllowedSubAgents is intentionally left unset on this path. The
		// engine's built-in Agent tool has no per-call source for "which
		// agents may this child dispatch" -- that is harness roster knowledge
		// the engine cannot synthesize. Fabricating one would be wrong, so the
		// allowlist layer stays inert here and only the self-dispatch rail
		// (enforced in checkDispatchEligibility regardless of the allowlist)
		// applies. A harness that dispatches via ctx.DispatchAgent sets
		// AllowedSubAgents per call and gets full allowlist enforcement.
		// Agent tool dispatch is async by default. Its context carries an
		// explicit wait_for_completion request when the model truly needs the
		// terminal result in this turn.
		waitForCompletion := tools.AgentWaitForCompletion(ctx)
		result, err := dispatchFn(extension.DispatchAgentOpts{
			Name:              name,
			Task:              prompt,
			Model:             model,
			ProjectPath:       cwd,
			MaxTurns:          0, // no limit; the child runs until done
			WaitForCompletion: waitForCompletion,
			Background:        !waitForCompletion,
		})
		if err != nil {
			return "", err
		}
		if result == nil {
			return "", nil
		}
		if !waitForCompletion {
			return "Agent dispatched asynchronously. Dispatch ID: " + result.DispatchID + ". The engine will deliver its terminal result automatically.", nil
		}
		// Usage suffix: model-facing per-dispatch token/cost accounting.
		// See dispatch_usage_suffix.go.
		return result.Output + FormatDispatchUsageSuffix(result), nil
	}
}
