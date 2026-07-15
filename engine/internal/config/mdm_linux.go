//go:build linux

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	mdmMainPath  = "/etc/ion-engine/managed-settings.json"
	mdmDropinDir = "/etc/ion-engine/managed-settings.d"
)

func loadPlatformMDM() map[string]interface{} {
	var result map[string]interface{}

	// Main config file.
	if data, err := os.ReadFile(mdmMainPath); err == nil {
		if err := json.Unmarshal(data, &result); err != nil {
			utils.LogWithFields(utils.LevelInfo, "config.mdm", "failed to parse main config", map[string]any{"path": mdmMainPath, "error": err.Error()})
		} else {
			utils.LogWithFields(utils.LevelInfo, "config.mdm", "loaded main config", map[string]any{"path": mdmMainPath})
		}
	}

	// Drop-in directory (alphabetical merge).
	entries, err := os.ReadDir(mdmDropinDir)
	if err != nil {
		return result
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(mdmDropinDir, entry.Name()))
		if err != nil {
			continue
		}
		var partial map[string]interface{}
		if err := json.Unmarshal(data, &partial); err != nil {
			utils.LogWithFields(utils.LevelInfo, "config.mdm", "failed to parse drop-in config", map[string]any{"path": entry.Name(), "error": err.Error()})
			continue
		}
		if result == nil {
			result = partial
		} else {
			for k, v := range partial {
				result[k] = v
			}
		}
		utils.LogWithFields(utils.LevelInfo, "config.mdm", "merged drop-in config", map[string]any{"path": entry.Name()})
	}

	return result
}
