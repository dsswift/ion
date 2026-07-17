package extcontext

import (
	"errors"
)

// Depth-guard constants and helpers for the dispatch path, split from
// dispatch_agent.go to keep that file under the 800-line cap. Same package;
// no API change.

// ExitCodeRecalled is the exit code used when a dispatch is cancelled via
// RecallAgent. Distinct from 0 (success) and 1 (error) so consumers can
// distinguish recall from failure.
const ExitCodeRecalled = 2

// DefaultMaxDispatchDepth is the built-in cap when neither the per-dispatch
// override (DispatchAgentOpts.MaxDispatchDepth) nor the engine config
// (EngineRuntimeConfig.MaxDispatchDepth) sets a value. Allows depths
// 0 (orchestrator), 1, and 2.
const DefaultMaxDispatchDepth = 3

// ErrDispatchDepthExceeded is returned by DispatchAgent when the requested
// dispatch would exceed the effective MaxDispatchDepth. The caller sees a
// typed error so it can distinguish depth rejection from other failures.
var ErrDispatchDepthExceeded = errors.New("dispatch depth exceeded")

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
