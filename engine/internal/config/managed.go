package config

// managed.go — the managed-mode marker.
//
// An administrator declares an installation managed by placing a marker file
// where a standard user cannot write. The marker is separate from policy, so
// it still says "managed" when the policy itself has gone missing. On a
// managed installation two things change:
//
//   - ION_ENTERPRISE_CONFIG is ignored. The engine runs as the user and
//     inherits the user's environment, so the variable is user-controlled.
//   - No resolvable machine policy locks the engine instead of leaving it
//     unrestricted (ManagedPolicyAbsent).
//
// With no marker nothing here changes any behavior.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// managedMarkerFileName is the marker's file name on every platform.
const managedMarkerFileName = "managed.json"

// managedMarkerPath resolves the marker path for a platform, or "" when the
// platform has no marker location. A var so a test can point it at a temp
// file; production never reassigns it.
var managedMarkerPath = defaultManagedMarkerPath

func defaultManagedMarkerPath(goos string) string {
	switch goos {
	case "darwin":
		return filepath.Join("/Library/Application Support/Ion", managedMarkerFileName)
	case "linux":
		return filepath.Join("/etc/ion", managedMarkerFileName)
	case "windows":
		root := windowsProgramDataRoot()
		if root == "" {
			return ""
		}
		return filepath.Join(root, "Ion", managedMarkerFileName)
	default:
		return ""
	}
}

// readManagedMarker reports whether the installation is marked managed, and
// the path it looked at. A missing file means unmanaged. A file that exists
// but cannot be read or parsed counts as managed: the marker lives where only
// an administrator can write, so a damaged one must not quietly unmanage the
// installation. Only an explicit {"managed": false} opts back out.
func readManagedMarker(goos string) (bool, string) {
	path := managedMarkerPath(goos)
	if path == "" {
		return false, ""
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, path
	}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "managed marker unreadable; treating installation as managed", map[string]any{"path": path, "error": err.Error()})
		return true, path
	}
	var marker struct {
		Managed *bool `json:"managed"`
	}
	if err := json.Unmarshal(data, &marker); err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "managed marker malformed; treating installation as managed", map[string]any{"path": path, "error": err.Error()})
		return true, path
	}
	if marker.Managed == nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "managed marker has no managed field; treating installation as managed", map[string]any{"path": path})
		return true, path
	}
	return *marker.Managed, path
}

// stampManagedMode sets cfg.ManagedMode from what the loader resolved and
// logs the outcome. Unmanaged clears the field, so a policy source cannot
// claim a status. Managed never returns nil: with no policy it returns a
// config carrying only the status, which is what locks the engine.
// refusedOverride is the ION_ENTERPRISE_CONFIG value that was ignored, or "".
func stampManagedMode(cfg *types.EnterpriseConfig, managed bool, refusedOverride, markerPath string) *types.EnterpriseConfig {
	if !managed {
		reportManagedMode(nil, "", markerPath)
		if cfg == nil || cfg.ManagedMode == nil {
			return cfg
		}
		clone := *cfg
		clone.ManagedMode = nil
		return &clone
	}

	status := &types.ManagedModeStatus{
		Managed:         true,
		PolicyAbsent:    cfg == nil,
		OverrideRefused: refusedOverride != "",
	}
	result := types.EnterpriseConfig{}
	if cfg != nil {
		result = *cfg
	}
	result.ManagedMode = status
	reportManagedMode(status, refusedOverride, markerPath)
	return &result
}

// ManagedPolicyAbsent reports whether the installation is managed and has no
// resolvable machine policy. Callers refuse work while it holds.
func ManagedPolicyAbsent(enterprise *types.EnterpriseConfig) bool {
	return enterprise != nil && enterprise.ManagedMode != nil && enterprise.ManagedMode.PolicyAbsent
}

var (
	managedReportMu   sync.Mutex
	managedReportLast string
	managedReportSeen bool
)

// reportManagedMode logs the managed-mode outcome and records its enforcement
// actions. Enterprise config is re-read on every config resolution, so this
// reports once per distinct outcome rather than once per read.
func reportManagedMode(status *types.ManagedModeStatus, refusedOverride, markerPath string) {
	state := "unmanaged"
	if status != nil {
		state = "managed"
		if status.PolicyAbsent {
			state += "+policy_absent"
		}
		if status.OverrideRefused {
			state += "+override_refused:" + refusedOverride
		}
	}
	managedReportMu.Lock()
	unchanged := managedReportSeen && managedReportLast == state
	managedReportSeen, managedReportLast = true, state
	managedReportMu.Unlock()
	if unchanged {
		return
	}

	if status == nil {
		utils.LogWithFields(utils.LevelDebug, "config.enterprise", "installation is unmanaged", map[string]any{"marker_path": markerPath})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "config.enterprise", "installation is managed", map[string]any{
		"marker_path": markerPath, "policy_absent": status.PolicyAbsent, "override_refused": status.OverrideRefused,
	})
	if status.OverrideRefused {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "enterprise policy override refused", map[string]any{
			"env_var": "ION_ENTERPRISE_CONFIG", "path": refusedOverride, "marker_path": markerPath,
		})
		recordEnforcement(EnforcementManagedOverrideRefused, refusedOverride, "ION_ENTERPRISE_CONFIG", nil)
	}
	if status.PolicyAbsent {
		utils.LogWithFields(utils.LevelError, "config.enterprise", "enterprise policy expected and absent", map[string]any{
			"marker_path": markerPath,
		})
		recordEnforcement(EnforcementManagedPolicyAbsent, markerPath, "managed-marker", nil)
	}
}
