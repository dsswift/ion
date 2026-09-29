package config

// enterprise_user.go — the per-user enterprise layer (manifest C11, program
// child 03).
//
// The machine layer (enterprise.go, enterprise_windows.go) is the sole
// policy ENFORCER: it is the only source that can lock, restrict, or narrow
// what a person may do. This file adds a second, per-user source whose only
// honored content is customFields['ion-desktop'].environments -- letting IT
// provision which Ion Studio Servers a specific person should see, without
// giving a person-writable file any power to loosen policy. Every other key
// found in a per-user source is ignored and logged at WARN; this file NEVER
// widens, narrows, or otherwise touches any other EnterpriseConfig field.
//
// Per-platform per-user sources:
//   - macOS: /Library/Managed Preferences/<user>/com.ion.engine.plist (an
//     MDM per-user profile, distinct from the machine-wide plist at
//     /Library/Managed Preferences/com.ion.engine.plist)
//   - Windows: HKCU\SOFTWARE\Policies\IonEngine, read permissively (raw
//     JSON, not run through the field-allowlisted decodeRegistryValues the
//     machine layer's HKLM read uses) so an unrecognized key is visible to
//     this layer's own WARN logging rather than silently dropped by the
//     machine-layer decoder. See enterprise_windows.go for why HKCU is
//     safe to read here despite never being read for machine policy.
//   - Linux: ~/.config/ion/enterprise-user.json

import (
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"runtime"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ionDesktopCustomFieldsKey and environmentsFieldKey name the one path this
// layer is allowed to read: customFields[ionDesktopCustomFieldsKey][environmentsFieldKey].
const (
	ionDesktopCustomFieldsKey = "ion-desktop"
	environmentsFieldKey      = "environments"
)

// EnvironmentEntry is one entry in customFields['ion-desktop'].environments
// (manifest C11): a server the desktop should offer as a managed catalog
// entry. Decoded permissively (raw map) so an unrecognized future field
// still round-trips into the merged policy rather than being dropped.
type EnvironmentEntry map[string]any

// environmentEntryURL extracts the entry's "url" key for dedup purposes.
// Returns "" when absent or not a string -- such an entry is kept (never
// silently dropped) but can never dedupe-collide with another.
func environmentEntryURL(e EnvironmentEntry) string {
	if v, ok := e["url"]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// loadUserEnvironmentLayer reads this platform's per-user source and
// returns the environment entries found under
// customFields['ion-desktop'].environments. Every other key in the source
// is logged at WARN (userLayerSource names which source, for the log line)
// and otherwise ignored -- this function's return value is the ONLY way
// this layer's content reaches the merged policy. Returns nil when the
// source is absent, unreadable, or carries no environments.
func loadUserEnvironmentLayer(goos string) []EnvironmentEntry {
	raw, source := readUserSource(goos)
	if raw == nil {
		return nil
	}
	return extractEnvironmentEntries(raw, source)
}

// extractEnvironmentEntries walks raw's customFields.ion-desktop object,
// returning the environments array (if present and shaped correctly) and
// logging WARN for every other key found at any of the three levels this
// layer inspects (root, customFields, customFields.ion-desktop).
func extractEnvironmentEntries(raw map[string]any, source string) []EnvironmentEntry {
	for k := range raw {
		if k != "customFields" {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": k, "source": source})
		}
	}

	customFieldsRaw, ok := raw["customFields"]
	if !ok {
		return nil
	}
	customFields, ok := customFieldsRaw.(map[string]any)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": "customFields", "source": source})
		return nil
	}

	for k := range customFields {
		if k != ionDesktopCustomFieldsKey {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": "customFields." + k, "source": source})
		}
	}

	ionDesktopRaw, ok := customFields[ionDesktopCustomFieldsKey]
	if !ok {
		return nil
	}
	ionDesktop, ok := ionDesktopRaw.(map[string]any)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": "customFields.ion-desktop", "source": source})
		return nil
	}

	for k := range ionDesktop {
		if k != environmentsFieldKey {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": "customFields.ion-desktop." + k, "source": source})
		}
	}

	envsRaw, ok := ionDesktop[environmentsFieldKey]
	if !ok {
		return nil
	}
	envsSlice, ok := envsRaw.([]any)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise user layer ignored key", map[string]any{"key": "customFields.ion-desktop.environments (not an array)", "source": source})
		return nil
	}

	entries := make([]EnvironmentEntry, 0, len(envsSlice))
	for _, e := range envsSlice {
		if m, ok := e.(map[string]any); ok {
			entries = append(entries, EnvironmentEntry(m))
		}
	}
	if len(entries) == 0 {
		return nil
	}
	return entries
}

// readUserSource dispatches to this platform's per-user source reader and
// returns the raw decoded JSON object plus a source label for logging.
// Returns (nil, "") when the platform has no per-user source, the source
// file/key is absent, or it fails to parse.
func readUserSource(goos string) (map[string]any, string) {
	switch goos {
	case "darwin":
		return readUserSourceMacOS()
	case "linux":
		return readUserSourceLinux()
	case "windows":
		raw, ok := readUserSourceWindowsRegistry()
		if !ok {
			return nil, ""
		}
		return raw, "windows-user-registry"
	default:
		return nil, ""
	}
}

// readUserSourceMacOS reads the per-user MDM profile at
// /Library/Managed Preferences/<user>/com.ion.engine.plist. Uses the same
// plutil-based JSON conversion the machine-layer reader uses, applied to
// the per-user path.
func readUserSourceMacOS() (map[string]any, string) {
	username := currentUsername()
	if username == "" {
		return nil, ""
	}
	path := filepath.Join("/Library/Managed Preferences", username, "com.ion.engine.plist")
	out := plutilToJSON(path)
	if out == nil {
		return nil, ""
	}
	var raw map[string]any
	if err := json.Unmarshal(out, &raw); err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "failed to parse macos per-user plist json", map[string]any{"path": path, "error": err.Error()})
		return nil, ""
	}
	return raw, "macos-user-plist"
}

// readUserSourceLinux reads ~/.config/ion/enterprise-user.json.
func readUserSourceLinux() (map[string]any, string) {
	home, err := utils.UserHomeDir()
	if err != nil || home == "" {
		return nil, ""
	}
	path := filepath.Join(home, ".config", "ion", "enterprise-user.json")
	data, err := os.ReadFile(path) //nolint:gosec // operator-configured path under the user's own home
	if err != nil {
		return nil, ""
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "failed to parse linux per-user enterprise source", map[string]any{"path": path, "error": err.Error()})
		return nil, ""
	}
	return raw, "linux-user-json"
}

// currentUsername resolves the current OS username for the macOS per-user
// plist path. Returns "" when unresolvable (never guesses).
func currentUsername() string {
	u, err := user.Current()
	if err != nil || u.Username == "" {
		return ""
	}
	return u.Username
}

// LoadUserEnvironmentLayer is the exported, GOOS-defaulted entry point
// mergeUserEnvironmentLayer calls. Kept as a thin wrapper so tests can call
// loadUserEnvironmentLayer(goos) directly with an explicit platform while
// production code (enterprise.go) calls this one.
func LoadUserEnvironmentLayer() []EnvironmentEntry {
	return loadUserEnvironmentLayer(runtime.GOOS)
}

// mergeUserEnvironmentLayer applies the per-user layer on top of an
// already-resolved machine config: the merged policy's
// customFields['ion-desktop'].environments becomes machine entries followed
// by per-user entries, deduplicated by url (machine wins a collision).
// Every other field of cfg is returned untouched -- this layer can only add
// environment entries, never remove, lock, or narrow anything.
//
// cfg may be nil (no machine config configured at all); in that case a
// non-nil per-user result still produces a minimal EnterpriseConfig
// carrying only the user-provisioned environments, so a machine with no
// MDM enrollment at all can still receive IT-provisioned server entries
// through the per-user channel alone.
func mergeUserEnvironmentLayer(cfg *types.EnterpriseConfig, goos string) *types.EnterpriseConfig {
	userEnvs := loadUserEnvironmentLayer(goos)
	if len(userEnvs) == 0 {
		return cfg
	}

	machineEnvs := machineEnvironmentEntries(cfg)
	merged := dedupeEnvironmentsByURL(machineEnvs, userEnvs)

	if cfg == nil {
		cfg = &types.EnterpriseConfig{}
	} else {
		clone := *cfg
		cfg = &clone
	}
	setIonDesktopEnvironments(cfg, merged)
	return cfg
}

// machineEnvironmentEntries reads the machine layer's own
// customFields.ion-desktop.environments, permissively, so it can be
// deduped against the per-user entries by the same code path. Returns nil
// when cfg is nil or carries no such entries.
func machineEnvironmentEntries(cfg *types.EnterpriseConfig) []EnvironmentEntry {
	if cfg == nil || cfg.CustomFields == nil {
		return nil
	}
	ionDesktop, ok := cfg.CustomFields[ionDesktopCustomFieldsKey].(map[string]any)
	if !ok {
		return nil
	}
	envsRaw, ok := ionDesktop[environmentsFieldKey]
	if !ok {
		return nil
	}
	envsSlice, ok := envsRaw.([]any)
	if !ok {
		return nil
	}
	entries := make([]EnvironmentEntry, 0, len(envsSlice))
	for _, e := range envsSlice {
		if m, ok := e.(map[string]any); ok {
			entries = append(entries, EnvironmentEntry(m))
		}
	}
	return entries
}

// setIonDesktopEnvironments writes merged into
// cfg.CustomFields['ion-desktop'].environments, creating the CustomFields
// and 'ion-desktop' maps if either is absent. Every other key already
// present under 'ion-desktop' (or at the CustomFields root) is preserved
// unchanged -- this only ever touches the one 'environments' key.
func setIonDesktopEnvironments(cfg *types.EnterpriseConfig, merged []EnvironmentEntry) {
	if cfg.CustomFields == nil {
		cfg.CustomFields = map[string]any{}
	}
	ionDesktop, ok := cfg.CustomFields[ionDesktopCustomFieldsKey].(map[string]any)
	if !ok {
		ionDesktop = map[string]any{}
	}
	envsAny := make([]any, len(merged))
	for i, e := range merged {
		envsAny[i] = map[string]any(e)
	}
	ionDesktop[environmentsFieldKey] = envsAny
	cfg.CustomFields[ionDesktopCustomFieldsKey] = ionDesktop
}

// dedupeEnvironmentsByURL returns machine entries followed by user entries,
// with a user entry dropped (DEBUG logged) when its "url" collides with a
// machine entry's -- the machine layer always wins a collision, per
// manifest C11's "the machine layer remains the sole enforcer" invariant:
// an environment entry is a place to connect, but a colliding URL most
// often means IT already provisioned this same server centrally, and the
// central entry (which may carry a "locked" reference the desktop resolves
// via EnvironmentPolicy) must be the one that survives.
func dedupeEnvironmentsByURL(machine, user []EnvironmentEntry) []EnvironmentEntry {
	seen := make(map[string]bool, len(machine))
	out := make([]EnvironmentEntry, 0, len(machine)+len(user))
	for _, e := range machine {
		out = append(out, e)
		if url := environmentEntryURL(e); url != "" {
			seen[url] = true
		}
	}
	for _, e := range user {
		url := environmentEntryURL(e)
		if url != "" && seen[url] {
			utils.LogWithFields(utils.LevelDebug, "config.enterprise", "per-user environment entry dropped: url collides with a machine entry", map[string]any{"url": url})
			continue
		}
		out = append(out, e)
	}
	return out
}
