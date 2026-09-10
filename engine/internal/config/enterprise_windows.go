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

// windowsPolicyRoot is the registry hive the policy key lives under.
// Production is always registry.LOCAL_MACHINE — the per-user hive is
// deliberately never read (a user can write their own per-user policy
// subtree, and policy must not be self-authored). Test seam: a test may
// repoint this at the current-user hive so it can create and clean up its
// own scratch key without administrator rights; production never does.
var windowsPolicyRoot = registry.LOCAL_MACHINE

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
	k, err := registry.OpenKey(windowsPolicyRoot, windowsPolicyKeyPath, registry.QUERY_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			utils.Debug("config.enterprise", "no policy key")
		} else {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "policy key unreadable", map[string]any{"error": err.Error()})
		}
		return nil
	}
	defer k.Close() //nolint:errcheck // best-effort handle close

	names, err := k.ReadValueNames(-1)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "policy key value names unreadable", map[string]any{"error": err.Error()})
		return nil
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

	cfg, unknown, warnings := decodeRegistryValues(values)
	for _, u := range unknown {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "unknown enterprise policy value name", map[string]any{"name": u})
	}
	for _, w := range warnings {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise policy value skipped", map[string]any{"name": w.Name, "error": w.Error.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "config.enterprise", "windows registry policy read", map[string]any{
		"value_names": names, "unknown_count": len(unknown),
	})
	return cfg
}
