//go:build windows

package config

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

const registryPath = `HKLM\SOFTWARE\Policies\IonEngine`

func loadPlatformMDM() map[string]interface{} {
	cfg, err := loadWindowsRegistry()
	if err != nil {
		// Registry key likely doesn't exist; not an error condition.
		return nil
	}
	if len(cfg) > 0 {
		utils.Log("MDM", "loaded config from Windows registry")
	}
	return cfg
}

func loadWindowsRegistry() (map[string]interface{}, error) {
	cmd := exec.Command("reg", "query", registryPath, "/s")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, err
	}
	return parseRegistryOutput(string(out)), nil
}

// parseRegistryOutput extracts REG_SZ values from `reg query` output.
// Certain well-known keys are parsed as lists or booleans.
func parseRegistryOutput(output string) map[string]interface{} {
	result := make(map[string]interface{})
	re := regexp.MustCompile(`^\s*(\S+)\s+REG_SZ\s+(.+)$`)

	for _, line := range strings.Split(output, "\n") {
		matches := re.FindStringSubmatch(strings.TrimSpace(line))
		if len(matches) != 3 {
			continue
		}
		key := matches[1]
		value := strings.TrimSpace(matches[2])

		switch key {
		case "AllowedModels", "BlockedModels", "AllowedProviders", "McpAllowlist", "McpDenylist":
			result[key] = strings.Split(value, ",")
		case "SandboxRequired":
			result[key] = strings.EqualFold(value, "true") || value == "1"
		case "ConfigJson":
			var parsed map[string]interface{}
			if json.Unmarshal([]byte(value), &parsed) == nil {
				for k, v := range parsed {
					result[k] = v
				}
			}
		default:
			result[key] = value
		}
	}
	return result
}
