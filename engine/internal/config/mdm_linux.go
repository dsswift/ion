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
			utils.Log("MDM", "failed to parse "+mdmMainPath+": "+err.Error())
		} else {
			utils.Log("MDM", "loaded config from "+mdmMainPath)
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
			utils.Log("MDM", "failed to parse drop-in "+entry.Name()+": "+err.Error())
			continue
		}
		if result == nil {
			result = partial
		} else {
			for k, v := range partial {
				result[k] = v
			}
		}
		utils.Log("MDM", "merged drop-in config: "+entry.Name())
	}

	return result
}
