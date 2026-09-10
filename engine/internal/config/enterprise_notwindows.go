//go:build !windows

package config

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// readWindows is the non-windows stub. loadEnterpriseConfig only calls this
// on runtime.GOOS == "windows" in production, but a test may call it
// directly on any platform to pin windowsPolicySources.
func readWindows() *types.EnterpriseConfig {
	utils.Debug("config.enterprise", "windows enterprise sources unavailable on this platform")
	return nil
}

// windowsPolicySources mirrors the windows-tagged file's list so
// enterprise_sources_test.go (all platforms) can assert it without a build
// tag of its own.
func windowsPolicySources() []string {
	return []string{"programdata", "registry-hklm"}
}
