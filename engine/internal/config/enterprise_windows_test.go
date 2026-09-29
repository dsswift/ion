//go:build windows

package config

import (
	"testing"

	"golang.org/x/sys/windows/registry"
)

// TestReadWindows_RegistryOverProgramData exercises readWindows end to end
// against a real (test-scratch) registry key: the production key path is
// swapped for an HKCU test key so the test needs no administrator rights,
// and windowsProgramDataRoot points at a temp directory. This is the
// production seam manifest contract C5 documents — the test repoints
// windowsPolicyRoot to registry.CURRENT_USER; production code never does.
func TestReadWindows_RegistryOverProgramData(t *testing.T) {
	origRoot := windowsPolicyRoot
	origKeyPath := windowsPolicyKeyPath
	origProgramData := windowsProgramDataRoot
	t.Cleanup(func() {
		windowsPolicyRoot = origRoot
		windowsPolicyKeyPath = origKeyPath
		windowsProgramDataRoot = origProgramData
	})

	windowsPolicyRoot = registry.CURRENT_USER
	windowsPolicyKeyPath = `SOFTWARE\IonEngineTest\` + t.Name()

	k, _, err := registry.CreateKey(windowsPolicyRoot, windowsPolicyKeyPath, registry.ALL_ACCESS)
	if err != nil {
		t.Fatalf("CreateKey: %v", err)
	}
	t.Cleanup(func() {
		k.Close()                                                   //nolint:errcheck // best-effort test cleanup
		registry.DeleteKey(windowsPolicyRoot, windowsPolicyKeyPath) //nolint:errcheck // best-effort test cleanup
	})

	if err := k.SetStringsValue("AllowedModels", []string{"model-a", "model-b"}); err != nil {
		t.Fatalf("SetStringsValue AllowedModels: %v", err)
	}
	if err := k.SetStringValue("ConfigJson", `{"blockedModels":["json-blocked"]}`); err != nil {
		t.Fatalf("SetStringValue ConfigJson: %v", err)
	}
	if err := k.SetStringValue("Foo", "unrecognized"); err != nil {
		t.Fatalf("SetStringValue Foo: %v", err)
	}

	programDataRoot := t.TempDir()
	windowsProgramDataRoot = func() string { return programDataRoot }
	writeProgramDataFile(t, programDataRoot, "Ion/enterprise-config.json", `{"blockedModels":["file-blocked"]}`)

	cfg := readWindows()
	if cfg == nil {
		t.Fatal("readWindows() returned nil")
	}
	if len(cfg.AllowedModels) != 2 || cfg.AllowedModels[0] != "model-a" || cfg.AllowedModels[1] != "model-b" {
		t.Errorf("AllowedModels = %v, want [model-a model-b] from the registry", cfg.AllowedModels)
	}
	// The registry's ConfigJson sets blockedModels=[json-blocked], but the
	// registry key as a whole overlays the ProgramData file
	// (mergeEnterprisePartial: registry wins), so the final value must be
	// the registry's, not the file's.
	if len(cfg.BlockedModels) != 1 || cfg.BlockedModels[0] != "json-blocked" {
		t.Errorf("BlockedModels = %v, want [json-blocked] (registry overlays programdata)", cfg.BlockedModels)
	}
}

// TestReadUserSourceWindowsRegistry_OnlyEnvironmentsSurvive extends the
// HKCU-never-read-for-MACHINE-policy invariant above: the per-user layer
// (manifest C11) DOES read HKCU, under a separate key
// (windowsUserPolicyKeyPath), but a per-user registry value carrying
// allowedModels, a locked flag, or any other policy-relevant key must never
// reach the merged EnterpriseConfig -- only
// customFields.ion-desktop.environments does. This test writes a
// ConfigJson value under a scratch HKCU key containing exactly the kind of
// content described in the "never-loosens" invariant, and asserts the
// per-user layer surfaces only the environments array.
func TestReadUserSourceWindowsRegistry_OnlyEnvironmentsSurvive(t *testing.T) {
	origKeyPath := windowsUserPolicyKeyPath
	t.Cleanup(func() { windowsUserPolicyKeyPath = origKeyPath })
	windowsUserPolicyKeyPath = `SOFTWARE\IonEngineUserTest\` + t.Name()

	k, _, err := registry.CreateKey(registry.CURRENT_USER, windowsUserPolicyKeyPath, registry.ALL_ACCESS)
	if err != nil {
		t.Fatalf("CreateKey: %v", err)
	}
	t.Cleanup(func() {
		k.Close()                                                           //nolint:errcheck // best-effort test cleanup
		registry.DeleteKey(registry.CURRENT_USER, windowsUserPolicyKeyPath) //nolint:errcheck // best-effort test cleanup
	})

	configJSON := `{
		"allowedModels": ["should-be-ignored"],
		"customFields": {
			"ion-desktop": {
				"environmentPolicy": {"mode": "central-only", "locked": true},
				"environments": [{"label": "Personal", "url": "wss://personal.example"}]
			}
		}
	}`
	if err := k.SetStringValue("ConfigJson", configJSON); err != nil {
		t.Fatalf("SetStringValue ConfigJson: %v", err)
	}

	raw, ok := readUserSourceWindowsRegistry()
	if !ok {
		t.Fatal("readUserSourceWindowsRegistry() = (_, false), want a value present")
	}

	entries := extractEnvironmentEntries(raw, "windows-user-registry-test")
	if len(entries) != 1 || entries[0]["label"] != "Personal" {
		t.Fatalf("entries = %+v, want one entry labeled Personal", entries)
	}

	// Confirm the raw map DOES carry the ignored keys (proving the registry
	// read itself is not the thing filtering them) -- extractEnvironmentEntries
	// above is what drops them, and that is asserted by the entries check.
	if _, hasAllowedModels := raw["allowedModels"]; !hasAllowedModels {
		t.Error("raw registry value unexpectedly missing allowedModels; the fixture is not exercising the drop path")
	}
}
