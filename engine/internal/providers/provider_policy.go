package providers

import (
	"sort"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/utils"
)

// provider_policy.go — the engine-wide provider allow-list.
//
// Enterprise allowedProviders strips user-declared provider blocks from the
// merged config, but the built-in providers (anthropic, openai, and the rest)
// register at startup with no config block at all. Without a gate here a bare
// "claude-*" id still resolves to the built-in anthropic provider and runs on
// whatever account that machine's CLI or key holds, which is the exact
// gateway bypass the allow-list exists to close.
//
// So the allow-list is installed into the registry once at daemon startup,
// after enterprise enforcement, and every registry read honours it: model
// lookup, provider resolution, prefix matching, and the model listing. A model
// whose provider is not permitted does not exist, so routing falls back to
// the engine's default model exactly as it does for any unknown id.
//
// Storage follows thinking_policy.go: a package-level atomic with a setter.

// allowedProviders holds the permitted provider ids. nil means unrestricted,
// the zero value, so an engine that never installs a policy behaves as before.
var allowedProviders atomic.Pointer[map[string]struct{}]

// SetAllowedProviders installs the provider allow-list. An empty list removes
// the restriction.
func SetAllowedProviders(ids []string) {
	if len(ids) == 0 {
		allowedProviders.Store(nil)
		utils.LogWithFields(utils.LevelInfo, "Providers", "install provider allow-list", map[string]any{"restricted": false})
		return
	}
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	allowedProviders.Store(&set)
	sorted := append([]string(nil), ids...)
	sort.Strings(sorted)
	utils.LogWithFields(utils.LevelInfo, "Providers", "install provider allow-list", map[string]any{"restricted": true, "allowed": sorted})
}

// ProviderPermitted reports whether the installed policy lets a model run on
// the provider with this id.
func ProviderPermitted(id string) bool {
	set := allowedProviders.Load()
	if set == nil {
		return true
	}
	_, ok := (*set)[id]
	return ok
}

// permittedOrNil returns p when its provider is permitted, otherwise nil with
// a log line naming the refused provider.
func permittedOrNil(p LlmProvider, model string) LlmProvider {
	if p == nil || ProviderPermitted(p.ID()) {
		return p
	}
	utils.LogWithFields(utils.LevelInfo, "Providers", "resolve provider refused by allow-list", map[string]any{"model": model, "provider": p.ID()})
	return nil
}
