// ext_context_suspender.go — extension-context construction and the Elicit
// accessor, with the DeadlineSuspender plumbing that lets a tool's indefinite
// human-wait (ctx.elicit) suspend the enclosing tool's finite deadline.
//
// Extracted from start_session.go to keep that file under the 800-line cap when
// the suspender wiring was added. The two newExtContext* constructors and the
// Elicit accessor live together because they form one cohesive unit: the
// constructor decides whether the accessor carries a suspender, and Elicit is
// the only accessor method that uses it.
package session

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
)

// newExtContext builds a fully-populated extension Context for the given
// session. All functional callbacks are wired through the
// extcontext.SessionAccessor interface. The accessor carries no suspender, so
// any Elicit reached through it waits under session lifecycle only (the
// non-tool path: hooks, commands, schedules).
func (m *Manager) newExtContext(s *engineSession, key string) *extension.Context {
	ctx := extcontext.NewExtContext(&sessionAccessor{m: m, s: s, key: key}, s.dispatchRegistry)
	ctx.SetRunRecovery = func(config *types.RunRecoveryConfig) {
		(&sessionAccessor{m: m, s: s, key: key}).SetRunRecovery(config)
	}
	return ctx
}

func (m *Manager) newCommandExtContext(s *engineSession, key string, overrides *PromptOverrides) *extension.Context {
	accessor := &sessionAccessor{m: m, s: s, key: key, commandOverrides: clonePromptOverrides(overrides)}
	ctx := extcontext.NewExtContext(accessor, s.dispatchRegistry)
	ctx.SetRunRecovery = func(config *types.RunRecoveryConfig) { accessor.SetRunRecovery(config) }
	return ctx
}

// newExtContextWithSuspender builds a per-tool-call extension context whose
// Elicit path can suspend the tool's finite deadline while blocked on a human.
// suspender may be nil (non-tool callers); the accessor then behaves exactly
// like newExtContext.
func (m *Manager) newExtContextWithSuspender(s *engineSession, key string, suspender types.DeadlineSuspender) *extension.Context {
	ctx := extcontext.NewExtContext(&sessionAccessor{m: m, s: s, key: key, suspender: suspender}, s.dispatchRegistry)
	ctx.SetRunRecovery = func(config *types.RunRecoveryConfig) {
		(&sessionAccessor{m: m, s: s, key: key, suspender: suspender}).SetRunRecovery(config)
	}
	return ctx
}

// Elicit raises an elicitation request and waits for the response. When this
// accessor was created on behalf of a tool call (suspender non-nil), it pauses
// the tool's finite deadline for exactly the span we block on the human, then
// resumes it for the remaining machine work. Without this, an indefinite
// human-wait reached through a tool's execute() would be capped — and severed —
// by the per-tool timeout. Pause/Resume are reference-counted and nil-safe.
func (a *sessionAccessor) Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	if a.suspender != nil {
		a.suspender.Pause()
		defer a.suspender.Resume()
	}
	return a.m.elicit(a.s, a.key, info)
}
