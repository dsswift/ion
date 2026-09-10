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
		k.Close() //nolint:errcheck // best-effort test cleanup
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
