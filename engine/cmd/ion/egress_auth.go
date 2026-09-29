package main

import (
	"context"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// exportTokenSource is the credential that mints bearer tokens for an
// off-machine export (log egress, OTLP traces and metrics).
type exportTokenSource struct {
	// name is the auth.oauth entry the token comes from ("" when the engine has
	// no identity provider configured).
	name string
	// kind is "identity_provider" (the engine's configured identity, looked up
	// at every mint so a later sign-in takes effect) or "machine_identity" (a
	// workload credential built for export).
	kind     string
	provider func() auth.TokenProvider
}

// tokenSourceResolver resolves auth.oauth entry names to export token
// sources. It builds each named machine identity once and hands the same
// instance to every export that names it: a second build from the same entry
// would fail, because the first consumed and removed its secret environment
// variable.
type tokenSourceResolver struct {
	authCfg *types.AuthConfig
	built   map[string]exportTokenSource
}

func newTokenSourceResolver(authCfg *types.AuthConfig) *tokenSourceResolver {
	return &tokenSourceResolver{authCfg: authCfg, built: map[string]exportTokenSource{}}
}

// resolve picks the credential that field (the config key naming it, for
// logs) selects. Unset, or naming auth.identityProvider, uses the identity
// provider's existing instance. A named machine identity entry gets its own
// manager. Anything else is logged as an error and falls back to the identity
// provider, which is the behavior when the field is unset.
func (r *tokenSourceResolver) resolve(field, name string) exportTokenSource {
	identity := exportTokenSource{kind: "identity_provider", provider: auth.CurrentTokenProvider}
	if r.authCfg != nil {
		identity.name = r.authCfg.IdentityProvider
	}
	if name == "" || name == identity.name {
		return identity
	}
	if src, ok := r.built[name]; ok {
		return src
	}

	fallback := func(msg string, fields map[string]any) exportTokenSource {
		fields["field"] = field
		fields["token_provider"] = name
		fields["fallback_provider"] = identity.name
		utils.LogWithFields(utils.LevelError, "main", msg, fields)
		return identity
	}
	var entry types.OAuthConfig
	ok := false
	if r.authCfg != nil {
		entry, ok = r.authCfg.OAuth[name]
	}
	if !ok {
		return fallback("token provider names a missing auth.oauth entry; export uses the identity provider", map[string]any{})
	}
	if entry.MachineIdentity == nil {
		return fallback("token provider names an interactive auth.oauth entry; the engine signs in only through auth.identityProvider, so export uses the identity provider", map[string]any{})
	}
	machine, err := auth.NewMachineIdentityManager(name, entry, r.authCfg.RefreshThresholdMs)
	if err != nil {
		return fallback("export machine identity build failed; export uses the identity provider", map[string]any{"error": err.Error()})
	}
	if machine.AWSProvider() != nil {
		return fallback("export machine identity provides AWS credentials, not bearer tokens; export uses the identity provider", map[string]any{"source": machine.SourceKind()})
	}
	src := exportTokenSource{name: name, kind: "machine_identity", provider: func() auth.TokenProvider { return machine }}
	r.built[name] = src
	return src
}

// resolveEgressTokenSource picks the credential for log egress from
// logging.egressTokenProvider.
func resolveEgressTokenSource(authCfg *types.AuthConfig, logging *types.LoggingConfig) exportTokenSource {
	return resolveEgressTokenSourceWith(newTokenSourceResolver(authCfg), logging)
}

func resolveEgressTokenSourceWith(r *tokenSourceResolver, logging *types.LoggingConfig) exportTokenSource {
	name := ""
	if logging != nil {
		name = logging.EgressTokenProvider
	}
	return r.resolve("logging.egressTokenProvider", name)
}

// egressAuthHeaders returns the flush-time header provider: a fresh bearer
// token for scope/audience from src, or nil headers when none can be minted
// (the flush then carries only the static headers).
func egressAuthHeaders(src exportTokenSource, scope, audience string) func() map[string]string {
	return func() map[string]string {
		provider := src.provider()
		if provider == nil {
			return nil
		}
		token, err := provider.GetTokenWithAudience(context.Background(), scope, audience)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "main", "egress token mint failed; flush proceeds with static headers", map[string]any{
				"provider": src.name, "kind": src.kind, "error": err.Error(),
			})
			return nil
		}
		return map[string]string{"Authorization": "Bearer " + token}
	}
}

// installEgressAuth authenticates log egress when logging.egressTokenScope or
// logging.egressTokenProvider is set: every flush then carries a freshly
// minted bearer token. Must run after the identity provider is configured.
func installEgressAuth(cfg *types.EngineRuntimeConfig) {
	installEgressAuthWith(cfg, newTokenSourceResolver(cfg.Auth))
}

func installEgressAuthWith(cfg *types.EngineRuntimeConfig, r *tokenSourceResolver) {
	if cfg.Logging == nil || (cfg.Logging.EgressTokenScope == "" && cfg.Logging.EgressTokenProvider == "") {
		return
	}
	src := resolveEgressTokenSourceWith(r, cfg.Logging)
	utils.SetEgressAuthHeaderProvider(egressAuthHeaders(src, cfg.Logging.EgressTokenScope, cfg.Logging.EgressTokenAudience))
	utils.LogWithFields(utils.LevelInfo, "main", "egress auth header provider installed", map[string]any{
		"tag": cfg.Logging.EgressTokenScope, "provider": src.name, "kind": src.kind,
	})
}
