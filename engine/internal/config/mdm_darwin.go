//go:build darwin

package config

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const mdmPlistPath = "/Library/Managed Preferences/com.ion.engine.plist"

func loadPlatformMDM() map[string]interface{} {
	if _, err := os.Stat(mdmPlistPath); err != nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "plutil", "-convert", "json", mdmPlistPath, "-o", "-").Output()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "config.mdm", "failed to read macos plist", map[string]any{"error": err.Error()})
		return nil
	}

	var result map[string]interface{}
	if err := json.Unmarshal(out, &result); err != nil {
		utils.LogWithFields(utils.LevelInfo, "config.mdm", "failed to parse macos plist json", map[string]any{"error": err.Error()})
		return nil
	}

	utils.Log("MDM", "loaded config from macOS managed preferences")
	return result
}
