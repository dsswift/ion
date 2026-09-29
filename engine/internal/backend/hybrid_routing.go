package backend

import (
	"context"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// credentialContextRequiresPrincipal derives the R-40 routing input from a
// RunConfig: whether cfg's CredentialContext would refuse the acting
// principal (attributed, fall-through policy says no). nil cfg or nil
// CredentialContext (an unattributed run, or a call site with no
// CredentialContext wired) is false -- unaffected by this program.
func credentialContextRequiresPrincipal(cfg *RunConfig) bool {
	if cfg == nil {
		return false
	}
	return cfg.CredentialContext.RequiresPrincipalCredential()
}

// keyOverrideFor returns the KeyHaver that should supersede the process-wide
// resolver for this run's HasKey check, or nil for an unattributed run (cfg
// nil, or cfg.CredentialContext nil/unattributed). Wrapping cfg's
// CredentialContext in contextKeyHaver is what makes kindFor's credential
// check answer for the ACTING PRINCIPAL rather than the process as a whole
// (child 06, R-13) -- the same object capability listing consults via
// buildProviderEntries, so the two never disagree.
func keyOverrideFor(ctx context.Context, cfg *RunConfig) KeyHaver {
	if cfg == nil || cfg.CredentialContext == nil {
		return nil
	}
	return contextKeyHaver{cc: cfg.CredentialContext, ctx: ctx}
}

// KeyHaver reports whether a provider has an API credential available right
// now. *auth.Resolver satisfies it; tests substitute a fake. The interface
// exists so routing can be exercised without touching the process keychain,
// env, or file store.
type KeyHaver interface {
	HasKey(provider string) (bool, string)
}

// contextKeyHaver adapts a *auth.CredentialContext to KeyHaver, so
// EffectiveBackendForProvider's principal-aware caller (server-side listing,
// child 06) and its per-run caller (kindFor, below) go through the exact same
// credential-presence question: CredentialContext.HasCredential. This is
// what keeps "what the UI shows" and "what the next run picks" in agreement
// (R-13) -- one implementation of "does this principal have a credential",
// consulted from both places.
type contextKeyHaver struct {
	cc  *auth.CredentialContext
	ctx context.Context
}

func (k contextKeyHaver) HasKey(providerID string) (bool, string) {
	ctx := k.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return k.cc.HasCredential(ctx, providerID)
}

// SetCliAuthProbe injects the live CLI install+auth predicate for the
// delegated CLI kinds ("claude-code"/"codex"/"grok"/"cursor"). The server
// wires this to its cliprobe.Registry so the backend package needs no cliprobe
// dependency. Nil (never wired — e.g. a Go-SDK consumer) is treated as "no CLI
// available": routing degrades safely to api. Idempotent; safe to call after
// construction and again on reconfigure.
func (h *HybridBackend) SetCliAuthProbe(fn func(kind string) bool) {
	h.mu.Lock()
	h.cliAuthed = fn
	h.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "SetCliAuthProbe: cli auth probe wired", map[string]any{"nil": fn == nil})
}

// EffectiveBackendForProvider is the single credential-based routing decision,
// shared by HybridBackend.kindFor (which backend serves a run) and the
// server's provider-entry projection (which backend the UI reports). Keeping
// them on one helper guarantees the displayed backend is the backend routing
// actually picks.
//
// Precedence:
//  1. explicit operator preference (providers.<id>.backend) — external
//     consumers who force a backend keep working;
//  2. API key available (live) → "api" (api-key-wins);
//  3. no key, provider's delegated CLI installed+authenticated (live) → that
//     CLI kind -- UNLESS requiresPrincipalCredential is true, in which case
//     the machine's shared CLI subscription must not serve a principal the
//     API path just refused (R-40): the back door child 04 closes;
//  4. neither → "api" for api-capable providers (clean missing-key error), or
//     the CLI kind for CLI-only providers (clean not-signed-in error) --
//     UNLESS requiresPrincipalCredential suppressed the CLI kind above, in
//     which case a CLI-only provider still routes to its CLI kind so the
//     refusal surfaces through the ordinary provider-auth path rather than a
//     confusing "no provider" error; the CLI backend itself is responsible
//     for its own not-signed-in/refusal behavior.
//
// Both keys and cliAuthed are consulted live on every call — no snapshot — so
// adding/removing a key or completing a CLI login changes routing on the next
// run with no restart.
func EffectiveBackendForProvider(providerID string, keys KeyHaver, cliAuthed func(kind string) bool, pref string, requiresPrincipalCredential bool) string {
	if pref != "" {
		utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: explicit preference", map[string]any{
			"provider_id": providerID,
			"kind":        pref,
		})
		return pref
	}
	if keys != nil {
		if has, src := keys.HasKey(providerID); has {
			utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: api key present", map[string]any{
				"provider_id": providerID,
				"source":      src,
				"kind":        "api",
			})
			return "api"
		}
	}
	cliKind, hasCli := config.CliBackendKind(providerID)
	if hasCli {
		if requiresPrincipalCredential {
			// R-40: an attributed principal whose API path requires its own
			// credential must not be silently served by the machine's
			// shared delegated-CLI subscription -- that is the exact
			// shared-credential outcome per-principal credentials exist to
			// end, through a different door.
			utils.LogWithFields(utils.LevelInfo, "backend.hybrid", "routing: cli fallback suppressed for attributed principal", map[string]any{
				"provider_id": providerID,
				"kind":        cliKind,
			})
			if !config.ApiBackendAllowed(providerID) {
				// CLI-only provider: still route to the CLI kind so the
				// refusal surfaces as an ordinary provider-auth failure
				// rather than a confusing "no provider" error. The CLI
				// backend's own subscription is what actually gets refused;
				// this routing decision does not by itself grant access.
				return cliKind
			}
		} else if cliAuthed != nil && cliAuthed(cliKind) {
			utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: no api key, cli authed", map[string]any{
				"provider_id": providerID,
				"kind":        cliKind,
			})
			return cliKind
		}
		if !config.ApiBackendAllowed(providerID) {
			utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: cli-only provider, cli not authed", map[string]any{
				"provider_id": providerID,
				"kind":        cliKind,
			})
			return cliKind
		}
		utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: cli not authed, falling to api", map[string]any{
			"provider_id": providerID,
			"cli_kind":    cliKind,
			"kind":        "api",
		})
		return "api"
	}
	utils.LogWithFields(utils.LevelDebug, "backend.hybrid", "routing: no api key, no cli capability", map[string]any{
		"provider_id": providerID,
		"kind":        "api",
	})
	return "api"
}

// kindFor resolves the backend kind that should serve a run for the given
// model: an explicit operator preference if present, otherwise the
// credential-based rule (api-key-wins → authed CLI → api). This is the
// requested kind, which may name a backend that has no implementation yet
// (see effectiveKind). The decision is made live per call — credential and
// CLI-auth changes take effect on the next run without reconstruction.
// requiresPrincipalCredential closes the CLI back door (R-40): true when the
// caller's CredentialContext derived a refusal-mode requirement for this
// run's acting principal.
//
// keyOverride, when non-nil, replaces h.keys for the HasKey check -- this is
// how an attributed run's own CredentialContext (via contextKeyHaver)
// supersedes the process-wide resolver, so "does this principal have a
// credential" is answered the same way routing decides AND the same way
// capability listing reports it (R-13). nil preserves the pre-existing
// unattributed behavior exactly.
func (h *HybridBackend) kindFor(model string, requiresPrincipalCredential bool, keyOverride KeyHaver) string {
	providerID := "<unknown>"
	if info := providers.GetModelInfo(model); info != nil {
		providerID = info.ProviderID
	}
	// Snapshot the seams under a short lock, then release before HasKey /
	// probe calls — both may do I/O (keychain, probe cache).
	h.mu.Lock()
	keys := h.keys
	cliAuthed := h.cliAuthed
	h.mu.Unlock()
	if keyOverride != nil {
		keys = keyOverride
	}
	pref := h.prefs[providerID] // immutable after construction, no lock
	return EffectiveBackendForProvider(providerID, keys, cliAuthed, pref, requiresPrincipalCredential)
}
