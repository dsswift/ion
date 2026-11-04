//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// launchAgentLabel is the label packaging/launchd/com.ion.engine.plist
// installs the engine under.
const launchAgentLabel = "com.ion.engine"

// startManagedEngine asks launchd to start the engine LaunchAgent and reports
// whether launchd took the request. It declines (false) when the client
// targets a non-default engine, since the LaunchAgent serves only the default
// socket, and when the LaunchAgent is not loaded, so the caller falls back to
// spawning an engine itself.
func startManagedEngine() bool {
	if os.Getenv("ION_SOCKET_PATH") != "" || os.Getenv("ION_DATA_DIR") != "" {
		return false
	}
	target := fmt.Sprintf("gui/%d/%s", os.Getuid(), launchAgentLabel)
	if err := exec.Command("launchctl", "print", target).Run(); err != nil {
		utils.LogWithFields(utils.LevelDebug, "main", "engine launchagent not loaded", map[string]any{"target": target})
		return false
	}
	if out, err := exec.Command("launchctl", "kickstart", target).CombinedOutput(); err != nil {
		utils.LogWithFields(utils.LevelWarn, "main", "engine launchagent kickstart failed", map[string]any{
			"target": target, "error": err.Error(), "output": strings.TrimSpace(string(out)),
		})
		return false
	}
	return true
}
