//go:build darwin

package utils

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var (
	ioregUUIDRe = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([^"]+)"`)
)

const macMDMPlistPath = "/Library/Managed Preferences/com.ion.engine.plist"

func loadPlatformMachineIdentity() platformIdentity {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var id string
	if out, err := exec.CommandContext(ctx, "ioreg", "-rd1", "-c", "IOPlatformExpertDevice").Output(); err == nil {
		s := string(out)
		if m := ioregUUIDRe.FindStringSubmatch(s); len(m) == 2 {
			id = strings.TrimSpace(m[1])
		}
	}

	var mdmID, mdmSerial string
	if _, err := os.Stat(macMDMPlistPath); err == nil {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel2()
		if out, err := exec.CommandContext(ctx2, "plutil", "-convert", "json", macMDMPlistPath, "-o", "-").Output(); err == nil {
			var m map[string]interface{}
			if json.Unmarshal(out, &m) == nil {
				if v, ok := m["MDMDeviceID"].(string); ok && v != "" {
					mdmID = v
				}
				if v, ok := m["MDMSerialNumber"].(string); ok && v != "" {
					mdmSerial = v
				}
			}
		}
	}

	return platformIdentity{machineID: id, mdmDeviceID: mdmID, mdmSerial: mdmSerial}
}
