package extension

import "github.com/dsswift/ion/engine/internal/auth"

// IdentityChangedInfo is a complete credential-free identity snapshot. A nil
// Identity means no verified operator identity is currently available.
type IdentityChangedInfo struct {
	Identity *auth.ContextIdentity `json:"identity,omitempty"`
	Reason   string                `json:"reason"`
	// SessionKey identifies the session whose principal was set or changed
	// (manifest C2). Empty for the process-level identity firing -- the
	// pre-existing behavior, unchanged -- and non-empty only when a
	// specific session's stamped principal is what changed.
	SessionKey string `json:"sessionKey,omitempty"`
}

// FireIdentityChanged delivers an identity snapshot to native handlers.
func (s *SDK) FireIdentityChanged(ctx *Context, info IdentityChangedInfo) error {
	s.fire(HookIdentityChanged, ctx, info)
	return nil
}
