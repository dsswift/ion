package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// useManagedMarker points the marker lookup at a temp file holding content,
// or at a path that does not exist when content is "".
func useManagedMarker(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), managedMarkerFileName)
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	orig := managedMarkerPath
	managedMarkerPath = func(string) string { return path }
	t.Cleanup(func() { managedMarkerPath = orig })
	return path
}

func writeEnvPolicy(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "enterprise.json")
	data, _ := json.Marshal(types.EnterpriseConfig{AllowedModels: []string{"user-chosen-model"}})
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", path)
	return path
}

// useMachinePolicy stands in for the platform's administrator-controlled
// machine source.
func useMachinePolicy(t *testing.T, policy types.EnterpriseConfig) {
	t.Helper()
	orig := platformEnterpriseReader
	platformEnterpriseReader = func(string) *types.EnterpriseConfig { return &policy }
	t.Cleanup(func() { platformEnterpriseReader = orig })
}

func TestReadManagedMarker(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    bool
	}{
		{"absent", "", false},
		{"managed true", `{"managed": true}`, true},
		{"managed false", `{"managed": false}`, false},
		{"malformed fails closed", `{not json`, true},
		{"missing field fails closed", `{}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := useManagedMarker(t, tc.content)
			got, gotPath := readManagedMarker("linux")
			if got != tc.want || gotPath != path {
				t.Fatalf("readManagedMarker = (%v, %q), want (%v, %q)", got, gotPath, tc.want, path)
			}
		})
	}
}

func TestDefaultManagedMarkerPath(t *testing.T) {
	orig := windowsProgramDataRoot
	windowsProgramDataRoot = func() string { return filepath.Join("C:", "ProgramData") }
	t.Cleanup(func() { windowsProgramDataRoot = orig })

	want := map[string]string{
		"darwin":  "/Library/Application Support/Ion/managed.json",
		"linux":   "/etc/ion/managed.json",
		"windows": filepath.Join("C:", "ProgramData", "Ion", "managed.json"),
		"plan9":   "",
	}
	for goos, path := range want {
		if got := defaultManagedMarkerPath(goos); got != path {
			t.Errorf("defaultManagedMarkerPath(%q) = %q, want %q", goos, got, path)
		}
	}
}

func TestManagedMode_NoMarker_EnvVarStillWins(t *testing.T) {
	useManagedMarker(t, "")
	writeEnvPolicy(t)

	cfg := loadMachineEnterpriseConfig("unsupported")
	if cfg == nil || len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "user-chosen-model" {
		t.Fatalf("unmanaged: expected env var policy, got %+v", cfg)
	}
	if cfg.ManagedMode != nil {
		t.Fatalf("unmanaged: expected no managed status, got %+v", cfg.ManagedMode)
	}
}

func TestManagedMode_NoMarker_NoPolicy_Unrestricted(t *testing.T) {
	useManagedMarker(t, "")
	t.Setenv("ION_ENTERPRISE_CONFIG", "")

	if cfg := loadMachineEnterpriseConfig("unsupported"); cfg != nil {
		t.Fatalf("unmanaged with no policy must stay nil, got %+v", cfg)
	}
}

func TestManagedMode_NoMarker_PolicyCannotClaimStatus(t *testing.T) {
	useManagedMarker(t, "")
	path := filepath.Join(t.TempDir(), "enterprise.json")
	if err := os.WriteFile(path, []byte(`{"managedMode":{"managed":true,"policyAbsent":true}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", path)

	cfg := loadMachineEnterpriseConfig("unsupported")
	if cfg == nil || cfg.ManagedMode != nil {
		t.Fatalf("a policy source must not set managedMode, got %+v", cfg)
	}
}

func TestManagedMode_Marker_NoPolicy_Locks(t *testing.T) {
	useManagedMarker(t, `{"managed": true}`)
	t.Setenv("ION_ENTERPRISE_CONFIG", "")

	cfg := loadMachineEnterpriseConfig("unsupported")
	if !ManagedPolicyAbsent(cfg) {
		t.Fatalf("managed with no policy must report policy absent, got %+v", cfg)
	}
	if cfg.ManagedMode.OverrideRefused {
		t.Fatal("no override was attempted")
	}
}

func TestManagedMode_Marker_EnvVarRefused_NoMachinePolicy(t *testing.T) {
	useManagedMarker(t, `{"managed": true}`)
	writeEnvPolicy(t)

	cfg := loadMachineEnterpriseConfig("unsupported")
	if !ManagedPolicyAbsent(cfg) || !cfg.ManagedMode.OverrideRefused {
		t.Fatalf("expected policy absent and override refused, got %+v", cfg.ManagedMode)
	}
	if len(cfg.AllowedModels) != 0 {
		t.Fatalf("env var policy leaked into a managed installation: %v", cfg.AllowedModels)
	}
}

func TestManagedMode_Marker_EnvVarRefused_MachinePolicyWins(t *testing.T) {
	useManagedMarker(t, `{"managed": true}`)
	writeEnvPolicy(t)
	useMachinePolicy(t, types.EnterpriseConfig{AllowedModels: []string{"machine-model"}})

	cfg := loadMachineEnterpriseConfig("linux")
	if cfg == nil || len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "machine-model" {
		t.Fatalf("expected machine policy, got %+v", cfg)
	}
	if ManagedPolicyAbsent(cfg) {
		t.Fatal("policy resolved, so it is not absent")
	}
	if cfg.ManagedMode == nil || !cfg.ManagedMode.Managed || !cfg.ManagedMode.OverrideRefused {
		t.Fatalf("expected managed with override refused, got %+v", cfg.ManagedMode)
	}
}

func TestManagedMode_Marker_MachinePolicy_NoOverride(t *testing.T) {
	useManagedMarker(t, `{"managed": true}`)
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	useMachinePolicy(t, types.EnterpriseConfig{AllowedModels: []string{"machine-model"}})

	cfg := loadMachineEnterpriseConfig("linux")
	if cfg == nil || cfg.ManagedMode == nil || cfg.ManagedMode.PolicyAbsent || cfg.ManagedMode.OverrideRefused {
		t.Fatalf("expected a clean managed status, got %+v", cfg)
	}
}

func TestManagedMode_RecordsDistinctEnforcementActions(t *testing.T) {
	DrainEnforcementActions()
	useManagedMarker(t, `{"managed": true}`)
	envPath := writeEnvPolicy(t)

	loadMachineEnterpriseConfig("unsupported")
	// A second read of the same outcome must not record again.
	loadMachineEnterpriseConfig("unsupported")

	kinds := map[EnforcementActionKind]int{}
	for _, a := range DrainEnforcementActions() {
		kinds[a.Kind]++
		if a.Kind == EnforcementManagedOverrideRefused && a.Subject != envPath {
			t.Errorf("override refused subject = %q, want %q", a.Subject, envPath)
		}
	}
	if kinds[EnforcementManagedPolicyAbsent] != 1 || kinds[EnforcementManagedOverrideRefused] != 1 {
		t.Fatalf("expected one of each managed action, got %v", kinds)
	}
}

func TestManagedMode_SerializesOnPolicyBlob(t *testing.T) {
	data, err := json.Marshal(types.EnterpriseConfig{
		ManagedMode: &types.ManagedModeStatus{Managed: true, PolicyAbsent: true, OverrideRefused: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"managedMode":{"managed":true,"policyAbsent":true,"overrideRefused":true}}`
	if string(data) != want {
		t.Fatalf("got %s, want %s", data, want)
	}
}
