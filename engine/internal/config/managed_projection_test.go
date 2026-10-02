package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// managedFixture is one isolated machine: a home with a global engine.json, a
// project with its own, and a directory for managed files.
type managedFixture struct {
	home       string
	projectDir string
	managedDir string
}

func newManagedFixture(t *testing.T, globalJSON, projectJSON string) managedFixture {
	t.Helper()
	f := managedFixture{home: t.TempDir(), projectDir: t.TempDir(), managedDir: t.TempDir()}
	t.Setenv("HOME", f.home)
	t.Setenv("ION_DATA_DIR", "")
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	useManagedMarker(t, "")
	f.write(t, filepath.Join(f.home, ".ion", "engine.json"), globalJSON)
	f.write(t, filepath.Join(f.projectDir, ".ion", "engine.json"), projectJSON)
	return f
}

func (f managedFixture) write(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// managed writes a managed file and returns its path.
func (f managedFixture) managed(t *testing.T, name, content string) string {
	t.Helper()
	return f.write(t, filepath.Join(f.managedDir, name), content)
}

func checksumOf(content string) string {
	sum := sha256.Sum256([]byte(content))
	return "sha256:" + hex.EncodeToString(sum[:])
}

const (
	userGlobalEngine  = `{"defaultModel":"user-model","limits":{"maxTurns":7},"mcpServers":{"user-server":{"command":"user-cmd"}}}`
	userProjectEngine = `{"defaultModel":"project-model","limits":{"maxBudgetUsd":3}}`
)

func TestManagedProjection_EngineFileReplacesLowerLayers(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, userProjectEngine)
	const managed = `{"defaultModel":"managed-model"}`
	path := f.managed(t, "engine.managed.json", managed)
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{EnginePath: path, SchemaVersion: 1},
	})

	cfg := mergeConfigLayers(f.projectDir)
	if cfg.DefaultModel != "managed-model" {
		t.Fatalf("DefaultModel = %q, want the managed value", cfg.DefaultModel)
	}
	// Keys the managed file leaves out resolve to defaults, not to the user's
	// global or project value.
	if cfg.Limits.MaxTurns != nil {
		t.Errorf("MaxTurns = %d, want unset: the global file must contribute nothing", *cfg.Limits.MaxTurns)
	}
	if cfg.Limits.MaxBudgetUsd != nil {
		t.Errorf("MaxBudgetUsd = %v, want unset: the project file must contribute nothing", *cfg.Limits.MaxBudgetUsd)
	}
	if len(cfg.McpServers) != 0 {
		t.Errorf("McpServers = %v, want none: the global file must contribute nothing", cfg.McpServers)
	}

	status := cfg.Enterprise.ManagedConfigStatus
	if status == nil || status.Engine == nil {
		t.Fatalf("ManagedConfigStatus = %+v, want an engine surface", status)
	}
	if !status.Engine.Projected || status.Engine.Error != "" {
		t.Errorf("engine status = %+v, want projected with no error", status.Engine)
	}
	if status.Engine.Checksum != checksumOf(managed) {
		t.Errorf("engine checksum = %q, want %q", status.Engine.Checksum, checksumOf(managed))
	}
	if status.Models != nil {
		t.Errorf("models status = %+v, want nil: no models file is declared", status.Models)
	}
	if status.SchemaVersion != 1 || status.SupportedSchemaVersion != ManagedConfigSchemaVersion {
		t.Errorf("schema versions = %d/%d", status.SchemaVersion, status.SupportedSchemaVersion)
	}
	if got := ManagedConfigError(cfg.Enterprise); got != "" {
		t.Errorf("ManagedConfigError = %q, want none", got)
	}
}

func TestManagedProjection_SealingStillAppliesOnTop(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, "{}")
	path := f.managed(t, "engine.managed.json", `{"defaultModel":"managed-model"}`)
	useMachinePolicy(t, types.EnterpriseConfig{
		AllowedModels: []string{"sealed-model"},
		ManagedConfig: &types.ManagedConfigSource{EnginePath: path, SchemaVersion: 1},
	})

	if got := mergeConfigLayers(f.projectDir).DefaultModel; got != "sealed-model" {
		t.Fatalf("DefaultModel = %q, want the sealed allowlist fallback", got)
	}
}

func TestManagedProjection_AbsentLeavesBehaviorUnchanged(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, userProjectEngine)
	// A policy with no managedConfig, carrying a status it has no right to set.
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfigStatus: &types.ManagedConfigStatus{Engine: &types.ManagedSurfaceStatus{Projected: true}},
	})

	cfg := mergeConfigLayers(f.projectDir)
	if cfg.DefaultModel != "project-model" {
		t.Errorf("DefaultModel = %q, want the project layer's", cfg.DefaultModel)
	}
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 7 {
		t.Errorf("MaxTurns = %v, want the global layer's 7", cfg.Limits.MaxTurns)
	}
	if cfg.Enterprise.ManagedConfigStatus != nil {
		t.Errorf("ManagedConfigStatus = %+v, want nil: a policy source cannot stamp it", cfg.Enterprise.ManagedConfigStatus)
	}
	if err := RefuseManagedConfigWrite(ManagedSurfaceEngine, "test"); err != nil {
		t.Errorf("RefuseManagedConfigWrite = %v, want nil with no managed source", err)
	}
	if _, owned, _ := ManagedModelsConfig(); owned {
		t.Error("ManagedModelsConfig owned = true, want false with no managed source")
	}
}

func TestManagedProjection_UnappliedFileOwnsSurfaceAndReportsError(t *testing.T) {
	cases := []struct {
		name      string
		version   int
		content   string // "" leaves the file missing
		relative  bool
		wantError string
	}{
		{"newer schema version", 2, `{"defaultModel":"managed-model"}`, false, "unsupported managed config schema version 2"},
		{"missing schema version", 0, `{"defaultModel":"managed-model"}`, false, "unsupported managed config schema version 0"},
		{"missing file", 1, "", false, "managed file is missing"},
		{"malformed file", 1, `{not json`, false, "managed file is not a JSON object"},
		{"non-object file", 1, `null`, false, "managed file is not a JSON object"},
		{"relative path", 1, `{}`, true, "managed file path is not absolute"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newManagedFixture(t, userGlobalEngine, userProjectEngine)
			path := filepath.Join(f.managedDir, "engine.managed.json")
			if tc.content != "" {
				f.managed(t, "engine.managed.json", tc.content)
			}
			if tc.relative {
				path = "engine.managed.json"
			}
			useMachinePolicy(t, types.EnterpriseConfig{
				ManagedConfig: &types.ManagedConfigSource{EnginePath: path, SchemaVersion: tc.version},
			})

			cfg := mergeConfigLayers(f.projectDir)
			// Not the managed value (the file was not applied) and not a
			// user value (the surface is still owned).
			if cfg.DefaultModel != "" {
				t.Errorf("DefaultModel = %q, want the built-in default", cfg.DefaultModel)
			}
			if cfg.Limits.MaxTurns != nil {
				t.Errorf("MaxTurns = %d, want unset", *cfg.Limits.MaxTurns)
			}
			status := cfg.Enterprise.ManagedConfigStatus
			if status == nil || status.Engine == nil {
				t.Fatalf("ManagedConfigStatus = %+v, want an engine surface", status)
			}
			if status.Engine.Projected {
				t.Error("engine Projected = true, want false")
			}
			if !strings.HasPrefix(status.Engine.Error, tc.wantError) {
				t.Errorf("engine Error = %q, want prefix %q", status.Engine.Error, tc.wantError)
			}
			if got := ManagedConfigError(cfg.Enterprise); !strings.Contains(got, tc.wantError) {
				t.Errorf("ManagedConfigError = %q, want it to carry %q", got, tc.wantError)
			}
			// A broken managed source still refuses writes.
			if err := RefuseManagedConfigWrite(ManagedSurfaceEngine, "test"); err == nil {
				t.Error("RefuseManagedConfigWrite = nil, want a refusal on an owned surface")
			}
		})
	}
}

func TestManagedProjection_BackendDefaultWriteRefused(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, "{}")
	path := f.managed(t, "engine.managed.json", `{}`)
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{EnginePath: path, SchemaVersion: 1},
	})
	_ = DrainEnforcementActions() // clear residue

	globalPath := filepath.Join(f.home, ".ion", "engine.json")
	_, _, err := SetBackendIfUnset(globalPath, "hybrid")
	var refused *ManagedConfigWriteError
	if !errors.As(err, &refused) {
		t.Fatalf("error = %v, want a ManagedConfigWriteError", err)
	}
	if refused.Surface != ManagedSurfaceEngine || refused.Operation != "set_backend_default" || refused.ResultCode() != ManagedConfigWriteRefusedCode {
		t.Errorf("refusal = %+v, code %q", refused, refused.ResultCode())
	}
	if data, _ := os.ReadFile(globalPath); string(data) != userGlobalEngine {
		t.Errorf("global engine.json changed: %s", data)
	}
	actions := DrainEnforcementActions()
	if len(actions) != 1 || actions[0].Kind != EnforcementManagedConfigWriteRefused {
		t.Errorf("recorded %+v, want one write refusal", actions)
	}
}

func TestManagedProjection_ModelsSurface(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, "{}")
	const managed = `{"tiers":{"fast":"managed-fast"}}`
	path := f.managed(t, "models.managed.json", managed)
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{ModelsPath: path, SchemaVersion: 1},
	})

	models, owned, err := ManagedModelsConfig()
	if !owned || err != nil {
		t.Fatalf("ManagedModelsConfig owned=%v err=%v, want owned with no error", owned, err)
	}
	if tiers, _ := models["tiers"].(map[string]any); tiers["fast"] != "managed-fast" {
		t.Errorf("managed models = %v", models)
	}

	// Only the models surface is declared: engine config keeps its layers.
	cfg := mergeConfigLayers(f.projectDir)
	if cfg.DefaultModel != "user-model" {
		t.Errorf("DefaultModel = %q, want the user layer's: the engine surface is not projected", cfg.DefaultModel)
	}
	status := cfg.Enterprise.ManagedConfigStatus
	if status == nil || status.Engine != nil || status.Models == nil || status.Models.Checksum != checksumOf(managed) {
		t.Errorf("status = %+v, want a projected models surface only", status)
	}
	if err := RefuseManagedConfigWrite(ManagedSurfaceEngine, "test"); err != nil {
		t.Errorf("engine write refused (%v) though only models is projected", err)
	}
	if err := RefuseManagedConfigWrite(ManagedSurfaceModels, "test"); err == nil {
		t.Error("models write permitted, want a refusal")
	}
}

func TestManagedProjection_UnappliedModelsFileReturnsError(t *testing.T) {
	f := newManagedFixture(t, "{}", "{}")
	useMachinePolicy(t, types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{ModelsPath: filepath.Join(f.managedDir, "absent.json"), SchemaVersion: 1},
	})
	models, owned, err := ManagedModelsConfig()
	if !owned || err == nil || models != nil {
		t.Fatalf("ManagedModelsConfig = %v, %v, %v; want owned with an error and no content", models, owned, err)
	}
}

func TestEnforcementSink_ReceivesActionsInPlaceOfBuffering(t *testing.T) {
	_ = DrainEnforcementActions()
	var got []EnforcementAction
	SetEnforcementSink(func(a EnforcementAction) { got = append(got, a) })
	t.Cleanup(func() { SetEnforcementSink(nil) })

	recordEnforcement(EnforcementManagedConfigWriteRefused, "mcp_add", ManagedSurfaceEngine, nil)
	if len(got) != 1 || got[0].Subject != "mcp_add" {
		t.Fatalf("sink received %+v, want the one action", got)
	}
	if buffered := DrainEnforcementActions(); len(buffered) != 0 {
		t.Errorf("buffered %+v, want nothing: the sink took the action", buffered)
	}
}

func TestMergeEnterprisePartial_CarriesManagedConfig(t *testing.T) {
	overlay := &types.EnterpriseConfig{ManagedConfig: &types.ManagedConfigSource{EnginePath: "/managed/engine.json", SchemaVersion: 1}}
	merged := mergeEnterprisePartial(&types.EnterpriseConfig{}, overlay)
	if merged.ManagedConfig == nil || merged.ManagedConfig.EnginePath != "/managed/engine.json" {
		t.Fatalf("ManagedConfig = %+v, want the drop-in's block", merged.ManagedConfig)
	}
}

// TestMergeConfigLayersWith_EnforcesTheCallersPolicy pins that a session's
// resolved policy, not a fresh machine read, is the one enforced.
func TestMergeConfigLayersWith_EnforcesTheCallersPolicy(t *testing.T) {
	f := newManagedFixture(t, userGlobalEngine, "{}")
	useMachinePolicy(t, types.EnterpriseConfig{})

	merged := mergeConfigLayersWith(f.projectDir, &types.EnterpriseConfig{AllowedModels: []string{"account-model"}})
	if merged.DefaultModel != "account-model" {
		t.Fatalf("DefaultModel = %q, want the caller's policy enforced", merged.DefaultModel)
	}
}
