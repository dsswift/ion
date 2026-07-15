package session

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireAgentSpawner installs the AgentSpawner closure on runCfg for the
// orchestrator's (depth-0) run. When the orchestrator's LLM invokes the Agent
// tool, this closure resolves the requested specialist (firing
// before_agent_start for the unnamed case and capability_match via
// resolveAgentSpec), resolves the child model and tier chain, then delegates
// the actual dispatch to the single shared dispatch mechanism
// (extcontext.BuildDispatchAgentFunc) at depth 0.
//
// Convergence: before this, wireAgentSpawner hand-rolled its own child-backend
// run loop that diverged from the extension dispatch path
// (BuildDispatchAgentFunc / BuildChildAgentSpawner). The bespoke path omitted
// four behaviors the dispatch path has: it never wired an AgentSpawner onto the
// child RunConfig (so an orchestrator-dispatched agent could not itself
// dispatch a sub-agent via the Agent tool), never emitted
// engine_dispatch_start/end telemetry (so the desktop dispatch-preview popup
// found no nested children), never stamped dispatchDepth/dispatchParentId on
// the agent pill, and never registered in the DispatchRegistry. Routing through
// BuildDispatchAgentFunc gives the orchestrator path all four for free and
// leaves one dispatch implementation instead of two that drift.
//
// agent_start / agent_end still fire on the parent extension group, the agent
// pill still appears, and live transcript activity is still forwarded — all of
// that now comes from inside BuildDispatchAgentFunc rather than being
// duplicated here. Hooks fire on the parent host (not the child) because they
// are documented as "Observe only": the parent observes its children's
// lifecycle.
func (m *Manager) wireAgentSpawner(s *engineSession, key string, parentModel string, extGroup *extension.ExtensionGroup, runCfg *backend.RunConfig) {
	capturedModel := parentModel
	capturedKey := key
	capturedExtGroup := extGroup

	runCfg.AgentSpawner = func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
		// If the LLM named a specialist, resolve it. Fires capability_match
		// when not registered so a harness extension can promote a draft
		// (via ctx.RegisterAgentSpec) and we resolve on the same call.
		// Falls back to an unnamed agent when the name is not registered,
		// so the model's intent (delegate work) still succeeds.
		var spec types.AgentSpec
		var specMatched bool

		// Fallback: when the LLM didn't pass a name, fire before_agent_start
		// so extensions can inspect the task and supply an agent name. This
		// is the belt-and-suspenders layer behind per-specialist dispatch
		// tools — if the generic Agent tool is called without a name, the
		// extension still gets a chance to resolve the specialist.
		if requestedName == "" && capturedExtGroup != nil && !capturedExtGroup.IsEmpty() {
			basCtx := m.newExtContext(s, capturedKey)
			_, hookName, _ := capturedExtGroup.FireBeforeAgentStart(basCtx, extension.AgentInfo{
				Task: prompt,
			})
			if hookName != "" {
				utils.LogWithFields(utils.LevelInfo, "session", "before_agent_start resolved", map[string]any{"model": hookName, "captured_key": capturedKey})
				requestedName = hookName
			}
		}

		if requestedName != "" {
			if matched, ok := m.resolveAgentSpec(s, key, requestedName); ok {
				spec = matched
				specMatched = true
			} else {
				utils.LogWithFields(utils.LevelDebug, "session", "agent spec not resolved: (continuing as unnamed)", map[string]any{"model": requestedName, "key": key})
			}
			// When resolution fails, continue with an unnamed agent rather
			// than hard-failing. The model's intent was to parallelize work;
			// the name was aspirational, not required.
		}

		// Naming: when a spec matched, the Name field is the spec name so
		// extensions and the shared dispatch path can correlate with the
		// roster. When unnamed, derive a stable per-dispatch name from the
		// session's agent counter. The shared dispatch mechanism
		// (BuildDispatchAgentFunc, invoked below) mints its own collision-safe
		// internal dispatch ID; this name is only the human/roster-facing
		// label. We still advance s.agentCounter so the unnamed label is
		// unique across dispatches in this session.
		s.agentCounter++
		agentName := fmt.Sprintf("agent-%d", s.agentCounter)
		if specMatched {
			agentName = spec.Name
		}

		displayName := description
		if displayName == "" {
			if specMatched && spec.Description != "" {
				displayName = spec.Description
			} else {
				displayName = agentName
				if len(prompt) > 60 {
					displayName = prompt[:60] + "..."
				} else if len(prompt) > 0 {
					displayName = prompt
				}
			}
			if idx := strings.IndexByte(displayName, '\n'); idx > 0 {
				displayName = displayName[:idx]
			}
		}

		// Use spec model if matched, then call-site model, then parent.
		childModel := model
		if childModel == "" && specMatched {
			childModel = spec.Model
		}
		if childModel == "" {
			childModel = capturedModel
		}

		// Resolve tier aliases (e.g. "standard" → "claude-sonnet-4-6") so child
		// runs get a concrete model ID. Without this, tier names from agent specs
		// pass through as literal model strings and fail provider resolution.
		var childFallbacks []string
		if childModel != "" {
			resolved, fallbacks := modelconfig.ResolveTierChain(childModel)
			if resolved != childModel {
				utils.LogWithFields(utils.LevelInfo, "session", "agent tier resolved: -> ()", map[string]any{"model": childModel, "resolved": resolved, "fallbacks": fallbacks, "model_3": agentName})
				childModel = resolved
			} else {
				utils.LogWithFields(utils.LevelDebug, "session", "agent tier passthrough", map[string]any{"model": childModel, "model_1": agentName})
			}
			childFallbacks = fallbacks
		}

		utils.LogWithFields(utils.LevelDebug, "session", "child model resolved", map[string]any{"model": model, "agent": agentName, "child_model": childModel})

		// Delegate the actual dispatch to the single shared dispatch
		// mechanism (extcontext.BuildDispatchAgentFunc). The orchestrator's
		// Agent tool and an extension's ctx.DispatchAgent now run the SAME
		// code path: spawner wiring (so a dispatched agent can itself dispatch
		// via the Agent tool), engine_dispatch_start/end telemetry (so the
		// desktop dispatch-preview popup can render nested children),
		// dispatchDepth/dispatchParentId attribution on the agent pill, and
		// DispatchRegistry registration. Before this convergence wireAgentSpawner
		// hand-rolled the child run and omitted all four, which is why an
		// orchestrator-dispatched agent could not dispatch a sub-agent and no
		// nested children ever appeared in the preview.
		//
		// Depth 0 / empty parent id: the orchestrator IS the depth-0 root, so
		// its direct dispatches are depth 1 with no parent dispatch. The
		// returned spawner's grandchildren inherit depth+1, enforced by the
		// depth guard inside BuildDispatchAgentFunc.
		//
		// Foreground (Background=false): the Agent tool blocks until the child
		// completes, matching its synchronous contract. Identical to how
		// BuildChildAgentSpawner delegates (dispatch_child_spawner.go).
		//
		// SystemPrompt is passed via DispatchAgentOpts.SystemPrompt, which
		// BuildDispatchAgentFunc applies as AppendSystemPrompt -- the matched
		// spec's persona augments the base system prompt rather than replacing
		// it. This matches the CLI-hook agent-spec path (prompt_cli_hooks.go)
		// and is the engine-consistent behavior.
		acc := &sessionAccessor{m: m, s: s, key: capturedKey}
		dispatchFn := extcontext.BuildDispatchAgentFunc(acc, s.dispatchRegistry, 0, "")
		dispatchOpts := extension.DispatchAgentOpts{
			Name:          agentName,
			Task:          prompt,
			Model:         childModel,
			ProjectPath:   cwd,
			DisplayName:   displayName,
			FallbackChain: childFallbacks,
			// Thread the per-tool-call context so cancelling the Agent tool
			// call (run abort, tool deadline) cancels this foreground dispatch
			// and returns promptly. The tool-call context derives from the
			// session, so session-level aborts still cascade.
			ParentCtx:  ctx,
			Background: false,
		}
		if specMatched {
			if spec.SystemPrompt != "" {
				dispatchOpts.SystemPrompt = spec.SystemPrompt
			}
			if len(spec.Tools) > 0 {
				dispatchOpts.AllowedTools = spec.Tools
			}
		}

		result, err := dispatchFn(dispatchOpts)
		// If the per-tool-call context was cancelled, surface the cancellation
		// to the run loop rather than a successful "recalled" result. The
		// shared dispatch path treats ParentCtx cancellation as a recall and
		// returns (result, nil); for the Agent tool, a cancelled call must
		// report context.Canceled so the run loop sees the abort. Checked first
		// so cancellation wins over any partial output.
		if ctxErr := ctx.Err(); ctxErr != nil {
			utils.LogWithFields(utils.LevelDebug, "session", "agent spawner cancelled", map[string]any{"model": agentName, "error": ctxErr})
			return "", ctxErr
		}
		if err != nil {
			utils.LogWithFields(utils.LevelDebug, "session", "agent spawner returning error", map[string]any{"model": agentName, "error": err})
			return "", err
		}
		if result == nil {
			utils.LogWithFields(utils.LevelDebug, "session", "agent spawner returning empty", map[string]any{"model": agentName})
			return "", nil
		}
		utils.LogWithFields(utils.LevelDebug, "session", "agent spawner returning", map[string]any{"model": agentName, "exit_code": result.ExitCode, "count": len(result.Output)})
		return result.Output, nil
	}
}

