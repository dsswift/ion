package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/auth"
)

// stampContextIdentity returns an invocation-local Context with a fresh,
// defensive identity snapshot. It does not mutate the caller's reusable
// session Context.
//
// Session principal first, process identity second (manifest C1/C2): when
// ctx already carries a session-level Identity (stamped by NewExtContext
// from the session's own principal), that value wins and this function only
// deep-copies it for invocation-local safety. Only a context with no
// session-level identity falls through to the process-wide operator
// identity -- the pre-existing behavior, unchanged for every session that
// carries no principal.
func stampContextIdentity(ctx *Context) *Context {
	if ctx == nil {
		return nil
	}
	stamped := *ctx
	if ctx.Identity != nil {
		stamped.Identity = cloneContextIdentityForInvocation(ctx.Identity)
		return &stamped
	}
	stamped.Identity = currentContextIdentity()
	return &stamped
}

// cloneContextIdentityForInvocation deep-copies a session-level identity so
// one handler's mutation of Claims cannot leak into another invocation's
// snapshot, mirroring currentContextIdentity's own JSON round-trip below.
func cloneContextIdentityForInvocation(identity *auth.ContextIdentity) *auth.ContextIdentity {
	encoded, err := json.Marshal(identity)
	if err != nil {
		return identity
	}
	var copied auth.ContextIdentity
	if err := json.Unmarshal(encoded, &copied); err != nil {
		return identity
	}
	return &copied
}

// currentContextIdentity resolves the verified identity provider at dispatch
// time. JSON round-tripping deep-copies arbitrary JSON claims so one handler
// cannot mutate another invocation's snapshot.
func currentContextIdentity() *auth.ContextIdentity {
	provider := auth.CurrentContextIdentityProvider()
	if provider == nil {
		return nil
	}
	identity := provider.ContextIdentity()
	if identity == nil {
		return nil
	}
	encoded, err := json.Marshal(identity)
	if err != nil {
		return nil
	}
	var copied auth.ContextIdentity
	if err := json.Unmarshal(encoded, &copied); err != nil {
		return nil
	}
	return &copied
}
