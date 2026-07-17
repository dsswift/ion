//go:build linux

package utils

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const linuxMDMDir = "/etc/ion-engine"

func loadPlatformMachineIdentity() platformIdentity {
	var id string

	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		id = strings.TrimSpace(string(b))
	}

	// Read MDM settings from the Linux managed-settings JSON (same source as
	// config.loadPlatformMDM on linux, but read directly here to avoid an
	// import cycle — utils must not import config).
	var mdmID, mdmSerial string
	if b, err := os.ReadFile(filepath.Join(linuxMDMDir, "managed-settings.json")); err == nil {
		var m map[string]interface{}
		if json.Unmarshal(b, &m) == nil {
			if v, ok := m["MDMDeviceID"].(string); ok && v != "" {
				mdmID = v
			}
			if v, ok := m["MDMSerialNumber"].(string); ok && v != "" {
				mdmSerial = v
			}
		}
	}

	return platformIdentity{machineID: id, mdmDeviceID: mdmID, mdmSerial: mdmSerial}
}
