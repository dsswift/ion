package utils

import (
	"sync"
)

// machineIdentity holds stable hardware and MDM identity fields stamped on
// every engine log line and egress record. Loaded once; never mutated.
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
		host := HostName()
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

// machineFieldsFromIdentity is the identity every engine.jsonl line carries:
// the same host, machine_id and MDM ids the server and desktop loggers stamp,
// so a log pipeline can label every line with the device it came from.
// Only non-empty values are included.
func machineFieldsFromIdentity(id machineIdentity) map[string]any {
	m := make(map[string]any, 5)
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
	return m
}

var (
	lineIdentityOnce   sync.Once
	lineIdentityFields map[string]any
)

// lineIdentity returns the machine identity stamped on every engine.jsonl
// line, loading it on first call.
func lineIdentity() map[string]any {
	lineIdentityOnce.Do(func() {
		if lineIdentityFields == nil {
			lineIdentityFields = machineFieldsFromIdentity(getMachineIdentity())
		}
	})
	return lineIdentityFields
}

// withMachineIdentity returns a copy of fields with identity stamped over it.
// Identity wins on a collision: these keys name the machine a line came from,
// and log pipelines label lines by them, so a caller's `host` meaning
// something else (a URL's host) must not relabel the line. Call sites name
// such values differently (scripts/check-logging.sh, RESERVED-KEY). fields
// itself is never mutated: the same map also goes to the egress forwarder.
func withMachineIdentity(fields, identity map[string]any) map[string]any {
	if len(identity) == 0 {
		return fields
	}
	out := make(map[string]any, len(fields)+len(identity))
	for k, v := range fields {
		out[k] = v
	}
	for k, v := range identity {
		out[k] = v
	}
	return out
}

// platformIdentity is the result of platform-specific hardware identity reads.
// Each platform file populates the fields it can source locally.
type platformIdentity struct {
	machineID   string
	mdmDeviceID string
	mdmSerial   string
}
