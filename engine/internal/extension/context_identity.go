package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/auth"
)

// stampContextIdentity returns an invocation-local Context with a fresh,
// defensive identity snapshot. It does not mutate the caller's reusable
// session Context.
func stampContextIdentity(ctx *Context) *Context {
	if ctx == nil {
		return nil
	}
	stamped := *ctx
	stamped.Identity = currentContextIdentity()
	return &stamped
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
