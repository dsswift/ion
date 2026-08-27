package session

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// requireToolUseDefault is the addressable `true` the built-in Agent tool
// passes as DispatchAgentOpts.RequireToolUse. A package-level var rather than a
// per-call local because the field is a *bool and taking the address of a
// literal is not possible; it is never written after init.
var requireToolUseDefault = true

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
	capturedRunID, _ := s.runIdentitySnapshot()
	runCfg.AgentSpawner = m.buildRootAgentSpawner(s, key, parentModel, extGroup, m.progressTarget(capturedRunID), runCfg.WorkspaceChecker)
}

// buildRootAgentSpawner returns the depth-0 AgentSpawner used by BOTH the
// ApiBackend orchestrator run (via wireAgentSpawner → runCfg.AgentSpawner) and
// the delegated-CLI ion_agent MCP tool (buildAgentToolHandler in
// prompt_cli_hooks.go). Routing both through one builder means a CLI parent's
// model-called ion_agent gets the SAME full dispatch as the API path:
// DispatchRegistry registration, engine_agent_state (agent panel), dispatch
// telemetry, child tool wiring (BuildDelegatedChildToolServer), and a
// grandchild-capable spawner — instead of the old bare synchronous child run
// that surfaced no agent and left the child tool-orphaned.
func (m *Manager) buildRootAgentSpawner(s *engineSession, key string, parentModel string, extGroup *extension.ExtensionGroup, progressTarget func(), workspaceChecker *workspaces.Checker) tools.AgentSpawner {
	capturedModel := parentModel
	capturedKey := key
	capturedExtGroup := extGroup

	return func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
		waitForCompletion := tools.AgentWaitForCompletion(ctx)
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
			_, hookName, _ := capturedExtGroup.FireBeforeAgentStart(basCtx, m.rootBeforeAgentStartInfo(prompt)) //nolint:errcheck // errors logged internally by fireVoid/s.fire
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

		// Tiers are operator configuration. A direct Agent-tool model string is
		// LLM-authored and may not select a different provider.
		modelOrigin := types.ModelOriginAgent
		if _, isTier := modelconfig.LookupTier(model); isTier {
			modelOrigin = types.ModelOriginConfig
		}
		childModel, childFallbacks, resolveErr := modelconfig.ResolveModelForOrigin(model, capturedModel, modelOrigin)
		if resolveErr != nil {
			utils.LogWithFields(utils.LevelWarn, "session", "agent model refused by provider lock", map[string]any{"requested_model": model, "parent_model": capturedModel, "agent": agentName, "error": resolveErr.Error()})
			return "", resolveErr
		}
		if childModel == "" && specMatched {
			childModel, childFallbacks = modelconfig.ResolveTierChain(spec.Model)
		}
		if childModel == "" {
			childModel = capturedModel
		}

		utils.LogWithFields(utils.LevelDebug, "session", "child model resolved", map[string]any{"requested_model": model, "agent": agentName, "child_model": childModel, "model_origin": modelOrigin})

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
		// The Agent tool and an extension's ctx.DispatchAgent now share the SAME
		// code path: spawner wiring, dispatch telemetry, nesting attribution, and
		// DispatchRegistry registration. Agent dispatch is asynchronous by default;
		// an explicit wait_for_completion request selects terminal output.
		//
		// SystemPrompt is passed via DispatchAgentOpts.SystemPrompt, which
		// BuildDispatchAgentFunc applies as AppendSystemPrompt -- the matched
		// spec's persona augments the base system prompt rather than replacing
		// it. This matches the CLI-hook agent-spec path (prompt_cli_hooks.go)
		// and is the engine-consistent behavior.
		acc := &sessionAccessor{m: m, s: s, key: capturedKey, progressTarget: progressTarget}
		dispatchFn := extcontext.BuildDispatchAgentFunc(acc, s.dispatchRegistry, 0, "", workspaceChecker)
		dispatchOpts := extension.DispatchAgentOpts{
			Name:  agentName,
			Task:  prompt,
			Model: childModel,
			ModelOrigin: func() types.ModelOrigin {
				if specMatched && model == "" {
					return types.ModelOriginConfig
				}
				return modelOrigin
			}(),
			ProjectPath:   cwd,
			DisplayName:   displayName,
			FallbackChain: childFallbacks,
			// Dispatches are asynchronous unless the model explicitly requests a
			// terminal result in this tool call. The child derives from the session
			// root in async mode so ending this tool call never cancels real work.
			ParentCtx:         ctx,
			WaitForCompletion: waitForCompletion,
			Background:        !waitForCompletion,
			// The built-in Agent tool declares required tool use on the
			// dispatcher's behalf, because there is no harness on this path to
			// declare it: the LLM called Agent directly, and the tool's own
			// description tells the model to "Dispatch a new child agent" to
			// "perform" a task. A child that answers the task instead of
			// performing it has not done what this tool exists to do.
			//
			// This is the path that produced the observed waste with no
			// extension loaded at all (system_prompt_len 0), so leaving it
			// undeclared would leave the reported case unfixed.
			//
			// Extension dispatches via ctx.dispatchAgent are untouched: they
			// pass their own RequireToolUse (or nil to opt out entirely),
			// because a harness knows which of its dispatches are analysis and
			// which are execution. Only this engine-owned tool defaults on.
			RequireToolUse: &requireToolUseDefault,
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
		if !waitForCompletion {
			tools.SetDispatchID(ctx, result.DispatchID)
			return fmt.Sprintf("Agent dispatched asynchronously. Dispatch ID: %s. Continue working or end your turn; the engine will deliver this agent's terminal result automatically.", result.DispatchID), nil
		}
		utils.LogWithFields(utils.LevelDebug, "session", "agent spawner returning", map[string]any{"model": agentName, "exit_code": result.ExitCode, "count": len(result.Output), "input_tokens": result.InputTokens, "output_tokens": result.OutputTokens})
		// Usage suffix: model-facing per-dispatch token/cost accounting. The
		// dispatch path already computes these numbers; without the suffix
		// they were dropped from the Agent tool result and the model had no
		// way to account for subagent spend. See extcontext/dispatch_usage_suffix.go.
		return result.Output + extcontext.FormatDispatchUsageSuffix(result), nil
	}
}
