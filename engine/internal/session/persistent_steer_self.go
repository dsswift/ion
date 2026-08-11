package session

import (
	"github.com/dsswift/ion/engine/internal/extension"
)

// persistentSteerSelf builds the session-scoped fallback for ext/steer_self.
//
// A dispatch's terminal callback reaches this after the parent run has exited,
// so its host ctxStack is empty and no context-owned SteerSelf closure exists.
// The fallback mirrors steerSelfWithKind's depth-zero resolution exactly:
// steer a live main run, otherwise inject a fresh classified prompt. Keeping
// this as one production helper lets the session wiring and its regression tests
// use the same closure rather than maintaining a test-only approximation that
// can silently drop an injection kind.
func (m *Manager) persistentSteerSelf(s *engineSession, key string) func(message, kind string) (extension.SteerDispatchResult, error) {
	return func(message, kind string) (extension.SteerDispatchResult, error) {
		acc := &sessionAccessor{m: m, s: s, key: key}
		if acc.SteerSelfMainLoopWithKind(message, kind) {
			return extension.SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
		}
		if err := acc.SendPromptWithKind(message, "", nil, kind); err != nil {
			return extension.SteerDispatchResult{Delivered: false, Outcome: "sent"}, err
		}
		return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
	}
}
