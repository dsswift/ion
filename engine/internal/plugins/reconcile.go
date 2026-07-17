// Package plugins — boot-time reconciliation of installed plugins against
// the merged engine config (user-layer + enterprise-layer).
package plugins

import (
	"path"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ReconcilePlugins compares the desired plugin state declared in cfg against
// the installed registry and brings them into alignment:
//
//  1. Installs any ForceInstalled sources not yet in the registry.
//  2. Removes any registry entries that are blocked by the effective denylist.
//  3. Removes any registry entries not in the effective allowlist (when an
//     allowlist is set).
//
// Enterprise force-installed plugins (cfg.Enterprise.PluginForceInstalled,
// already merged into cfg.Plugins.ForceInstalled by EnforceEnterprise) bypass
// allowlist checks — the enterprise controls what it mandates. User-layer
// force-installs are subject to the enterprise allowlist: if an enterprise
// allowlist is set and the source is not on it, the force-install is skipped
// and a warning is logged.
//
// Called synchronously from cmdServe, before the socket is opened, so every
// session created after boot operates against a fully reconciled plugin set.
// Install is idempotent: an already-cached SHA skips the download. The typical
// hot path (no changes needed) completes in milliseconds.
func ReconcilePlugins(cfg *types.EngineRuntimeConfig, progress func(string)) {
	if cfg == nil {
		return
	}

	var pluginsCfg types.PluginsConfig
	if cfg.Plugins != nil {
		pluginsCfg = *cfg.Plugins
	}

	var enterpriseCfg *types.EnterpriseConfig
	if cfg.Enterprise != nil {
		enterpriseCfg = cfg.Enterprise
	}

	// Collect the effective force-install list from both layers.
	// EnforceEnterprise has already merged them into cfg.Plugins.ForceInstalled,
	// so we only need the single list here.
	forceInstalled := pluginsCfg.ForceInstalled

	// --- Step 1: install missing force-installed plugins ---
	if len(forceInstalled) > 0 {
		existing, err := ListInstalled()
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "failed to list installed plugins", map[string]any{
				"error": err.Error(),
			})
		} else {
			installedSources := make(map[string]bool, len(existing))
			for _, p := range existing {
				installedSources[p.Source] = true
			}

			for _, source := range forceInstalled {
				if installedSources[source] {
					utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "force-installed plugin already present", map[string]any{
						"source": source,
					})
					continue
				}

				// User force-installs are subject to the enterprise allowlist.
				// Enterprise force-installs have already been merged and bypass
				// allowlist checks (allowlist is for user-chosen plugins).
				// We use IsPluginAllowed which checks both allowlist and denylist.
				if !IsPluginAllowed(source, enterpriseCfg) {
					utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "force-installed plugin blocked by enterprise policy — skipping", map[string]any{
						"source": source,
					})
					if progress != nil {
						progress("Plugin " + source + " blocked by enterprise policy — skipping force-install")
					}
					continue
				}

				msg := "Force-installing plugin " + source + "..."
				utils.Log("plugins.reconcile", msg)
				if progress != nil {
					progress(msg)
				}
				if _, err := Install(source, progress); err != nil {
					utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "force-install failed", map[string]any{
						"source": source, "error": err.Error(),
					})
				}
			}
		}
	}

	// --- Steps 2 & 3: enforce denylist and allowlist against the registry ---
	current, err := ListInstalled()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "failed to list installed plugins for policy enforcement", map[string]any{
			"error": err.Error(),
		})
		return
	}

	for _, p := range current {
		reason := ""

		// Denylist check: user denylist + enterprise denylist (already merged).
		if pluginMatchesDenylist(p.Source, pluginsCfg.Denylist) {
			reason = "user denylist"
		} else if enterpriseCfg != nil && pluginMatchesDenylist(p.Source, enterpriseCfg.PluginDenylist) {
			reason = "enterprise denylist"
		}

		// Allowlist check: only when an allowlist is set (empty = no restriction).
		// Enterprise allowlist takes precedence; user allowlist applies when no
		// enterprise allowlist is set.
		if reason == "" {
			if enterpriseCfg != nil && len(enterpriseCfg.PluginAllowlist) > 0 {
				if !globMatchesAny(enterpriseCfg.PluginAllowlist, p.Source) {
					reason = "not in enterprise allowlist"
				}
			} else if len(pluginsCfg.Allowlist) > 0 {
				if !globMatchesAny(pluginsCfg.Allowlist, p.Source) {
					reason = "not in user allowlist"
				}
			}
		}

		if reason != "" {
			utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "removing plugin blocked by policy", map[string]any{
				"name": p.Name, "source": p.Source, "reason": reason,
			})
			if progress != nil {
				progress("Removing plugin " + p.Name + " (" + reason + ")")
			}
			if err := Remove(p.Name); err != nil {
				utils.LogWithFields(utils.LevelInfo, "plugins.reconcile", "failed to remove plugin", map[string]any{
					"name": p.Name, "error": err.Error(),
				})
			}
		}
	}
}

// IsPluginAllowed reports whether a plugin source is permitted by enterprise
// policy. Glob patterns are supported (e.g. "JuliusBrussee/*"). When enterprise
// is nil, all sources are allowed.
func IsPluginAllowed(source string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return true
	}
	if IsPluginDenied(source, enterprise) {
		return false
	}
	if len(enterprise.PluginAllowlist) > 0 && !globMatchesAny(enterprise.PluginAllowlist, source) {
		return false
	}
	return true
}

// IsPluginDenied reports whether a plugin source is blocked by enterprise policy.
// Glob patterns are supported. When enterprise is nil, nothing is denied.
func IsPluginDenied(source string, enterprise *types.EnterpriseConfig) bool {
	if enterprise == nil {
		return false
	}
	return pluginMatchesDenylist(source, enterprise.PluginDenylist)
}

func pluginMatchesDenylist(source string, denylist []string) bool {
	return globMatchesAny(denylist, source)
}

// globMatchesAny returns true when target matches any of the given glob patterns.
// Uses path.Match semantics: "JuliusBrussee/*" matches "JuliusBrussee/caveman".
// Exact-string matches are always tried as a fallback.
func globMatchesAny(patterns []string, target string) bool {
	for _, p := range patterns {
		if p == target {
			return true
		}
		if ok, _ := path.Match(p, target); ok {
			return true
		}
	}
	return false
}
