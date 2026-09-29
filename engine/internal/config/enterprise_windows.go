//go:build windows

package config

import (
	"os"

	"golang.org/x/sys/windows/registry"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// windowsPolicyKeyPath is the registry key the engine reads enterprise
// policy from. Test seam: a test may repoint this at a scratch subkey under
// windowsPolicyRoot; production code never changes it.
var windowsPolicyKeyPath = `SOFTWARE\Policies\IonEngine`

// windowsPolicyRoot is the registry hive the MACHINE policy key lives
// under. Production is always registry.LOCAL_MACHINE — HKCU is deliberately
// never read for MACHINE policy (a user can write their own per-user
// registry subtree, and policy must not be self-authored). Test seam: a
// test may repoint this at the current-user hive so it can create and
// clean up its own scratch key without administrator rights; production
// never does.
//
// This invariant governs readRegistryPolicy only. The per-user layer
// (manifest C11, readUserSourceWindowsRegistry in enterprise_user_windows.go)
// deliberately DOES read the current-user hive under a different key path
// (windowsUserPolicyKeyPath) -- that is safe specifically because its
// output is restricted to one additive, non-enforcing field
// (customFields.ion-desktop.environments) by extractEnvironmentEntries,
// which logs and discards every other key a person could write there. A
// per-user source can never lock, narrow, or loosen policy; it can only
// offer additional places to connect.
var windowsPolicyRoot = registry.LOCAL_MACHINE

// windowsUserPolicyKeyPath is the registry key the per-user layer
// (manifest C11) reads under the current-user hive. Distinct from
// windowsPolicyKeyPath (the machine policy key) even though both use the
// same subtree name -- the difference is entirely which hive owns them.
var windowsUserPolicyKeyPath = `SOFTWARE\Policies\IonEngine`

// windowsProgramDataRoot resolves %ProgramData%. A func var so a test can
// substitute a temp directory.
var windowsProgramDataRoot = func() string { return os.Getenv("ProgramData") }

// windowsPolicySources names, in prose, the sources readWindows checks, for
// docs and for the pinned test that asserts HKCU never appears in this list.
func windowsPolicySources() []string {
	return []string{"programdata", "registry-hklm"}
}

// readWindows implements the Windows branch of loadEnterpriseConfig, per
// manifest contract C5: ProgramData main file, then its drop-ins, then the
// HKLM policy key overlaid on top with mergeEnterprisePartial.
func readWindows() *types.EnterpriseConfig {
	cfg, reports := readProgramDataDir(windowsProgramDataRoot())
	for _, r := range reports {
		logProgramDataReport(r)
	}
	if cfg != nil {
		utils.Log("config.enterprise", "loaded enterprise config from programdata")
	}

	reg := readRegistryPolicy()
	if reg != nil {
		if cfg != nil {
			cfg = mergeEnterprisePartial(cfg, reg)
		} else {
			cfg = reg
		}
		utils.Log("config.enterprise", "loaded enterprise config from windows registry")
	}
	return cfg
}

func logProgramDataReport(r programDataSourceReport) {
	switch {
	case r.Error != nil:
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise source present", map[string]any{
			"source": r.Source, "path": r.Path, "error": r.Error.Error(),
		})
	case r.Present:
		utils.LogWithFields(utils.LevelInfo, "config.enterprise", "enterprise source present", map[string]any{
			"source": r.Source, "path": r.Path,
		})
	default:
		utils.LogWithFields(utils.LevelDebug, "config.enterprise", "enterprise source absent", map[string]any{
			"source": r.Source, "path": r.Path,
		})
	}
}

// readRegistryPolicy opens windowsPolicyKeyPath under windowsPolicyRoot,
// reads every value, classifies each by its registry type, and decodes them
// into an EnterpriseConfig via decodeRegistryValues. Returns nil when the
// key is absent (the normal, unenrolled case) or unreadable (a permission
// error, treated as absent — never a fatal error for the caller).
func readRegistryPolicy() *types.EnterpriseConfig {
	values, ok := readRegistryValues(windowsPolicyRoot, windowsPolicyKeyPath)
	if !ok {
		return nil
	}

	cfg, unknown, warnings := decodeRegistryValues(values)
	for _, u := range unknown {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "unknown enterprise policy value name", map[string]any{"name": u})
	}
	for _, w := range warnings {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise policy value skipped", map[string]any{"name": w.Name, "error": w.Error.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "config.enterprise", "windows registry policy read", map[string]any{
		"unknown_count": len(unknown),
	})
	return cfg
}

// readRegistryValues opens keyPath under root, reads every value, and
// classifies each by its registry type. The second return is false when the
// key is absent (the normal, unenrolled case) or unreadable (a permission
// error) -- both treated as "nothing to read" by every caller, never a
// fatal error. Shared by the machine-layer HKLM read above and the
// per-user HKCU read (enterprise_user_windows.go), which differ only in
// which key they open and how they decode the resulting values.
func readRegistryValues(root registry.Key, keyPath string) ([]registryValue, bool) {
	k, err := registry.OpenKey(root, keyPath, registry.QUERY_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			utils.Debug("config.enterprise", "no policy key")
		} else {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "policy key unreadable", map[string]any{"error": err.Error()})
		}
		return nil, false
	}
	defer k.Close() //nolint:errcheck // best-effort handle close

	names, err := k.ReadValueNames(-1)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "policy key value names unreadable", map[string]any{"error": err.Error()})
		return nil, false
	}

	values := make([]registryValue, 0, len(names))
	for _, name := range names {
		_, valType, err := k.GetValue(name, nil)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "registry value unreadable", map[string]any{"name": name, "error": err.Error()})
			continue
		}
		switch valType {
		case registry.SZ, registry.EXPAND_SZ:
			s, _, err := k.GetStringValue(name)
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "config.enterprise", "registry value unreadable", map[string]any{"name": name, "error": err.Error()})
				continue
			}
			values = append(values, registryValue{Name: name, Kind: RegString, Str: s})
		case registry.MULTI_SZ:
			ss, _, err := k.GetStringsValue(name)
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "config.enterprise", "registry value unreadable", map[string]any{"name": name, "error": err.Error()})
				continue
			}
			values = append(values, registryValue{Name: name, Kind: RegMultiString, Strs: ss})
		case registry.DWORD, registry.QWORD:
			n, _, err := k.GetIntegerValue(name)
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "config.enterprise", "registry value unreadable", map[string]any{"name": name, "error": err.Error()})
				continue
			}
			values = append(values, registryValue{Name: name, Kind: RegInteger, Num: n})
		default:
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "unsupported registry value type", map[string]any{"name": name, "type": valType})
		}
	}
	return values, true
}
