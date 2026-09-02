package extcontext

import (
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolveDispatchModelTier maps a configured tier name (e.g. "fast") to its
// concrete model and fallback chain for a dispatched child run.
//
// This is the shared dispatch seam's tier resolution. Every dispatch — the
// Agent tool, an extension's ctx.dispatchAgent, and the Poll driver — passes
// through BuildDispatchAgentFunc, so resolving here is what makes a tier name
// usable by all of them. Before this existed, only the Agent tool and root
// prompts resolved tiers; a caller that built DispatchAgentOpts directly sent
// the literal tier name to the provider as a model ID.
//
// The function is deliberately idempotent and non-destructive:
//
//   - An empty request returns empty, leaving the caller's DefaultModel
//     fallback in charge.
//   - A concrete model ID is not a configured tier name, so LookupTier misses
//     and the value passes through unchanged. A caller that already resolved
//     its own tier (prompt_agent_spawner) is therefore unaffected.
//   - A caller-supplied fallback chain always wins. Only a tier that resolves
//     AND carries its own chain, for a caller that supplied none, contributes
//     fallbacks.
//
// Provider locking is NOT applied here. That decision belongs to the caller
// that knows the request's origin: prompt_agent_spawner passes LLM-authored
// model strings through modelconfig.ResolveModelForOrigin first, because an
// LLM may not select a different provider. A tier is operator configuration,
// so its configured provider is always allowed — which is exactly what this
// function resolves and nothing more.
func resolveDispatchModelTier(requested string, callerFallbacks []string) (string, []string) {
	if requested == "" {
		return "", callerFallbacks
	}
	tier, ok := modelconfig.LookupTier(requested)
	if !ok {
		return requested, callerFallbacks
	}
	fallbacks := callerFallbacks
	if len(fallbacks) == 0 {
		fallbacks = tier.Fallbacks
	}
	utils.LogWithFields(utils.LevelInfo, "session.dispatch", "dispatch model tier resolved", map[string]any{
		"tier":           tier.Name,
		"model":          tier.Model,
		"fallback_count": len(fallbacks),
	})
	return tier.Model, fallbacks
}
