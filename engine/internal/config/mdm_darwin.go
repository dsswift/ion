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
		utils.Log("MDM", "failed to read macOS plist: "+err.Error())
		return nil
	}

	var result map[string]interface{}
	if err := json.Unmarshal(out, &result); err != nil {
		utils.Log("MDM", "failed to parse macOS plist JSON: "+err.Error())
		return nil
	}

	utils.Log("MDM", "loaded config from macOS managed preferences")
	return result
}
