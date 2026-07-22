package utils

import (
	"os"
	"sync"
)

// machineIdentity holds stable hardware and MDM identity fields stamped on
// every engine egress record. Populated once at forwarder init; never mutated.
type machineIdentity struct {
	Host        string
	MachineID   string
	MDMDeviceID string
	MDMSerial   string
}

var (
	machineIdentityOnce   sync.Once
	cachedMachineIdentity machineIdentity
)

// getMachineIdentity returns the cached machine identity, loading it on first
// call. Safe for concurrent use after init.
func getMachineIdentity() machineIdentity {
	machineIdentityOnce.Do(func() {
		host, _ := os.Hostname() //nolint:errcheck // empty hostname fallback
		platform := loadPlatformMachineIdentity()

		cachedMachineIdentity = machineIdentity{
			Host:        host,
			MachineID:   platform.machineID,
			MDMDeviceID: platform.mdmDeviceID,
			MDMSerial:   platform.mdmSerial,
		}
	})
	return cachedMachineIdentity
}

// ambientFieldsFromIdentity builds the fields map to merge into every egress
// record. Only non-empty values are included. install_id (the per-install
// anonymous UUID) is included alongside the hardware machine_id: they are
// DISTINCT identifiers, not a naming drift. install_id joins egress records to
// the telemetry stream (which stamps the same value); machine_id stays
// hardware-stable across reinstalls. Both ship. See docs/observability/log-schema.md.
func ambientFieldsFromIdentity(id machineIdentity) map[string]any {
	m := make(map[string]any, 6)
	if id.Host != "" {
		m["host"] = id.Host
	}
	if id.MachineID != "" {
		m["machine_id"] = id.MachineID
	}
	if id.MDMDeviceID != "" {
		m["mdm_device_id"] = id.MDMDeviceID
	}
	if id.MDMSerial != "" {
		m["mdm_serial"] = id.MDMSerial
	}
	if iid := InstallID(); iid != "" {
		m["install_id"] = iid
	}
	return m
}

// platformIdentity is the result of platform-specific hardware identity reads.
// Each platform file populates the fields it can source locally.
type platformIdentity struct {
	machineID   string
	mdmDeviceID string
	mdmSerial   string
}
