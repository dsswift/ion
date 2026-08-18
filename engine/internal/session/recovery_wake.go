package session

import "github.com/dsswift/ion/engine/internal/types"

// isRecoveryWakeKind identifies engine-authored work that may resume a parked
// recovery. User input remains queued while recovery ownership is active.
func isRecoveryWakeKind(kind string) bool {
	switch types.InjectionKind(kind) {
	case types.InjectionKindRunRecovery,
		types.InjectionKindAgentCompletion,
		types.InjectionKindBackgroundTaskCompletion,
		types.InjectionKindRevive:
		return true
	default:
		return false
	}
}
