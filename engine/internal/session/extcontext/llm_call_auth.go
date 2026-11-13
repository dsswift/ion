package extcontext

import (
	"context"
	"errors"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// withPrincipalCredential attaches the session principal's credential for
// providerID to ctx, so a one-shot call authenticates exactly as the
// session's run loop and its dispatched agents do. The session wires its
// credential context onto a run config; a config with none (no resolver on
// this backend) leaves ctx unchanged, and the provider's own request path
// decides as it does for any unattributed request.
func withPrincipalCredential(ctx context.Context, sa SessionAccessor, providerID string) context.Context {
	cfg := &backend.RunConfig{}
	sa.WirePrincipalRunConfig(cfg)
	cc := cfg.CredentialContext
	if cc == nil {
		utils.LogWithFields(utils.LevelDebug, "session.llm_call", "no credential context", map[string]any{"session_key": sa.SessionKey(), "provider": providerID})
		return ctx
	}
	a, err := cc.Authenticator(ctx, providerID)
	if err != nil {
		if errors.Is(err, auth.ErrPrincipalCredentialUnresolved) {
			utils.LogWithFields(utils.LevelInfo, "session.llm_call", "principal credential refused", map[string]any{"session_key": sa.SessionKey(), "provider": providerID, "subject": cc.Subject()})
			return providers.WithCredentialRefusal(ctx, cc.Subject())
		}
		utils.LogWithFields(utils.LevelInfo, "session.llm_call", "no request credential", map[string]any{"session_key": sa.SessionKey(), "provider": providerID, "error": err.Error()})
		return ctx
	}
	if a == nil {
		return ctx
	}
	utils.LogWithFields(utils.LevelDebug, "session.llm_call", "request credential attached", map[string]any{"session_key": sa.SessionKey(), "provider": providerID, "subject": cc.Subject()})
	return providers.WithRequestCredential(ctx, a)
}
