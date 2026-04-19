package config

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// LoadEnterpriseConfig loads enterprise configuration from platform-appropriate sources.
//
// Sources checked in order:
//  1. ION_ENTERPRISE_CONFIG env var (path to JSON file, all platforms)
//  2. macOS: /Library/Managed Preferences/com.ion.engine.plist
//  3. Linux: /etc/ion/config.json + /etc/ion/config.d/*.json
func LoadEnterpriseConfig() *types.EnterpriseConfig {
	return loadEnterpriseConfig(runtime.GOOS)
}

func loadEnterpriseConfig(goos string) *types.EnterpriseConfig {
	// Env var override (all platforms)
	if envPath := os.Getenv("ION_ENTERPRISE_CONFIG"); envPath != "" {
		if cfg := readJSONFile[types.EnterpriseConfig](envPath); cfg != nil {
			utils.Log("Enterprise", "loaded config from ION_ENTERPRISE_CONFIG: "+envPath)
			return cfg
		}
	}

	switch goos {
	case "darwin":
		return readMacOS()
	case "linux":
		return readLinux()
	case "windows":
		return readWindows()
	default:
		return nil
	}
}

// readMacOS reads enterprise config from macOS managed preferences (plist).
func readMacOS() *types.EnterpriseConfig {
	const plistPath = "/Library/Managed Preferences/com.ion.engine.plist"
	if _, err := os.Stat(plistPath); err != nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "plutil", "-convert", "json", plistPath, "-o", "-").Output()
	if err != nil {
		utils.Log("Enterprise", "failed to read macOS plist: "+err.Error())
		return nil
	}

	var cfg types.EnterpriseConfig
	if err := json.Unmarshal(out, &cfg); err != nil {
		utils.Log("Enterprise", "failed to parse macOS plist JSON: "+err.Error())
		return nil
	}
	utils.Log("Enterprise", "loaded config from macOS plist")
	return &cfg
}

// readLinux reads enterprise config from /etc/ion/config.json + /etc/ion/config.d/*.json.
func readLinux() *types.EnterpriseConfig {
	var cfg *types.EnterpriseConfig

	// Main config file
	const mainPath = "/etc/ion/config.json"
	cfg = readJSONFile[types.EnterpriseConfig](mainPath)
	if cfg != nil {
		utils.Log("Enterprise", "loaded config from "+mainPath)
	}

	// Drop-in directory (alphabetical merge)
	const dropinDir = "/etc/ion/config.d"
	entries, err := os.ReadDir(dropinDir)
	if err != nil {
		return cfg
	}

	// Sort alphabetically
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		partial := readJSONFile[types.EnterpriseConfig](filepath.Join(dropinDir, entry.Name()))
		if partial == nil {
			continue
		}
		if cfg == nil {
			cfg = partial
		} else {
			cfg = mergeEnterprisePartial(cfg, partial)
		}
		utils.Log("Enterprise", "merged drop-in config: "+entry.Name())
	}

	return cfg
}

// readWindows reads enterprise config from the Windows registry.
// Uses the same registry path as MDM (HKLM\SOFTWARE\Policies\IonEngine).
// Tries "Config" first (TS compatibility), then falls back to "ConfigJson".
func readWindows() *types.EnterpriseConfig {
	for _, valueName := range []string{"Config", "ConfigJson"} {
		cfg := readWindowsRegistryValue(valueName)
		if cfg != nil {
			return cfg
		}
	}
	return nil
}

// readWindowsRegistryValue queries a single REG_SZ value from the IonEngine registry key.
func readWindowsRegistryValue(valueName string) *types.EnterpriseConfig {
	cmd := exec.Command("reg", "query", `HKLM\SOFTWARE\Policies\IonEngine`, "/v", valueName)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	// Parse the REG_SZ value from reg query output.
	// Format: "    <valueName>    REG_SZ    {json...}"
	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.Contains(line, "REG_SZ") {
			continue
		}
		parts := strings.SplitN(line, "REG_SZ", 2)
		if len(parts) != 2 {
			continue
		}
		jsonStr := strings.TrimSpace(parts[1])
		var cfg types.EnterpriseConfig
		if err := json.Unmarshal([]byte(jsonStr), &cfg); err != nil {
			utils.Log("Enterprise", "failed to parse Windows registry "+valueName+": "+err.Error())
			return nil
		}
		utils.Log("Enterprise", "loaded config from Windows registry ("+valueName+")")
		return &cfg
	}
	return nil
}

// mergeEnterprisePartial does a shallow merge of enterprise config (later wins for scalars/slices).
func mergeEnterprisePartial(base, overlay *types.EnterpriseConfig) *types.EnterpriseConfig {
	result := *base
	if len(overlay.AllowedModels) > 0 {
		result.AllowedModels = overlay.AllowedModels
	}
	if len(overlay.BlockedModels) > 0 {
		result.BlockedModels = overlay.BlockedModels
	}
	if len(overlay.AllowedProviders) > 0 {
		result.AllowedProviders = overlay.AllowedProviders
	}
	if len(overlay.RequiredHooks) > 0 {
		result.RequiredHooks = overlay.RequiredHooks
	}
	if len(overlay.McpAllowlist) > 0 {
		result.McpAllowlist = overlay.McpAllowlist
	}
	if len(overlay.McpDenylist) > 0 {
		result.McpDenylist = overlay.McpDenylist
	}
	if overlay.ToolRestrictions != nil {
		result.ToolRestrictions = overlay.ToolRestrictions
	}
	if overlay.Telemetry != nil {
		result.Telemetry = overlay.Telemetry
	}
	if overlay.Network != nil {
		result.Network = overlay.Network
	}
	if overlay.Sandbox != nil {
		result.Sandbox = overlay.Sandbox
	}
	if len(overlay.CustomFields) > 0 {
		result.CustomFields = overlay.CustomFields
	}
	return &result
}

func readJSONFile[T any](path string) *T {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		utils.Log("Enterprise", "failed to parse "+path+": "+err.Error())
		return nil
	}
	return &v
}
