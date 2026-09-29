//go:build windows

package config

// enterprise_user_windows.go — the Windows registry half of the per-user
// enterprise layer (manifest C11, program child 03). Deliberately split
// from enterprise_windows.go (the machine-policy reader): that file is the
// target of TestEnterpriseWindowsSourceFileNeverNamesCurrentUser, a
// grep-style pin asserting the machine policy reader never references
// registry.CURRENT_USER. This file DOES reference CURRENT_USER -- reading
// HKCU is exactly the point of the per-user layer -- and is safe to do so
// only because its output is restricted to one additive, non-enforcing
// field (customFields.ion-desktop.environments) by
// extractEnvironmentEntries (enterprise_user.go), which logs and discards
// every other key a person could write there. See windowsPolicyRoot's doc
// comment in enterprise_windows.go for the full invariant this file is the
// deliberate, narrow exception to.

import (
	"encoding/json"
	"strings"

	"golang.org/x/sys/windows/registry"

	"github.com/dsswift/ion/engine/internal/utils"
)

// readUserSourceWindowsRegistry reads windowsUserPolicyKeyPath under
// HKEY_CURRENT_USER and returns its ConfigJson/Config value(s), permissively
// decoded as a raw JSON object, plus whether a key was found at all. Unlike
// readRegistryPolicy (the machine layer), this does NOT decode per-field
// registry values against the EnterpriseConfig field index -- the per-user
// layer's caller (enterprise_user.go extractEnvironmentEntries) inspects
// the raw object itself and logs WARN for every key that is not
// customFields.ion-desktop.environments, so decoding through the
// field-allowlisted machine-layer path would silently hide exactly the
// keys this layer exists to reject loudly.
func readUserSourceWindowsRegistry() (map[string]any, bool) {
	values, ok := readRegistryValues(registry.CURRENT_USER, windowsUserPolicyKeyPath)
	if !ok {
		return nil, false
	}
	raw := map[string]any{}
	found := false
	for _, v := range values {
		lower := strings.ToLower(v.Name)
		if lower != "configjson" && lower != "config" {
			continue
		}
		text := joinIfMulti(v)
		var obj map[string]any
		if err := json.Unmarshal([]byte(text), &obj); err != nil {
			utils.LogWithFields(utils.LevelWarn, "config.enterprise", "failed to parse windows per-user registry json", map[string]any{"name": v.Name, "error": err.Error()})
			continue
		}
		for k, val := range obj {
			raw[k] = val
		}
		found = true
	}
	if !found {
		return nil, false
	}
	return raw, true
}
