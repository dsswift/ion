package backend

import (
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// KeyHaver reports whether a provider has an API credential available right
// now. *auth.Resolver satisfies it; tests substitute a fake. The interface
// exists so routing can be exercised without touching the process keychain,
// env, or file store.
type KeyHaver interface {
	HasKey(provider string) (bool, string)
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
//     CLI kind;
//  4. neither → "api" for api-capable providers (clean missing-key error), or
//     the CLI kind for CLI-only providers (clean not-signed-in error).
//
// Both keys and cliAuthed are consulted live on every call — no snapshot — so
// adding/removing a key or completing a CLI login changes routing on the next
// run with no restart.
func EffectiveBackendForProvider(providerID string, keys KeyHaver, cliAuthed func(kind string) bool, pref string) string {
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
		if cliAuthed != nil && cliAuthed(cliKind) {
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
func (h *HybridBackend) kindFor(model string) string {
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
	pref := h.prefs[providerID] // immutable after construction, no lock
	return EffectiveBackendForProvider(providerID, keys, cliAuthed, pref)
}
