package extcontext

// Depth-guard constants and helpers for the dispatch path, split from
// dispatch_agent.go to keep that file under the 800-line cap. Same package;
// no API change.

// ExitCodeRecalled is the exit code used when a dispatch is cancelled via
// RecallAgent. Distinct from 0 (success) and 1 (depth-cap rejection) so
// consumers can distinguish recall from a rejected dispatch.
const ExitCodeRecalled = 2

// DefaultMaxDispatchDepth is the built-in cap when neither the per-dispatch
// override (DispatchAgentOpts.MaxDispatchDepth) nor the engine config
// (EngineRuntimeConfig.MaxDispatchDepth) sets a value. Allows depths
// 0 (orchestrator), 1, and 2.
const DefaultMaxDispatchDepth = 3

// ErrSelfDispatch and ErrSubAgentNotAllowed (the eligibility-guard errors)
// are defined in dispatch_eligibility.go alongside the guard that returns them.

// resolveMaxDispatchDepth returns the effective depth cap for a dispatch,
// preferring the per-dispatch override, then the engine config, then the
// built-in default.
func resolveMaxDispatchDepth(perDispatch int, engineCfg int) int {
	if perDispatch > 0 {
		return perDispatch
	}
	if engineCfg > 0 {
		return engineCfg
	}
	return DefaultMaxDispatchDepth
}

// remainingDepthBudget reports child dispatch levels available to an agent at
// currentDepth under effectiveCap. A cap reached by the next child reports 0.
func remainingDepthBudget(effectiveCap, currentDepth int) int {
	budget := effectiveCap - currentDepth
	if budget < 0 {
		return 0
	}
	return budget
}

// RemainingDepthBudgetForRoot resolves the engine cap and returns levels
// available to the root agent (depth 0). Used by session startup to populate
// before_agent_start payload.
func RemainingDepthBudgetForRoot(engineCap int) int {
	return remainingDepthBudget(resolveMaxDispatchDepth(0, engineCap), 0)
}
