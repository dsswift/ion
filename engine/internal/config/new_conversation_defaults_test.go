package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func writeJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolveNewConversationDefaults_ProjectProfileNameIsPortable(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("HOME", home)
	writeJSON(t, filepath.Join(home, ".ion", "settings.json"), map[string]any{
		"engineProfiles": []map[string]any{{"id": "host-specific-id", "name": "review", "extensions": []string{"/host/extensions/review"}}},
	})
	writeJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"profileName": "review", "profileLocked": true},
	})

	got := ResolveNewConversationDefaults(project)
	if got.ProfileName != "review" || got.ProfileID != "host-specific-id" {
		t.Fatalf("resolved profile = (%q, %q), want portable review mapped to host-specific-id", got.ProfileName, got.ProfileID)
	}
	if len(got.Extensions) != 1 || got.Extensions[0] != "/host/extensions/review" {
		t.Fatalf("extensions = %v", got.Extensions)
	}
	if !got.ProfileLocked {
		t.Fatal("expected project profile lock")
	}
}

func TestResolveNewConversationDefaults_ProjectOverridesGlobalAndEnterpriseWins(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	enterprise := filepath.Join(t.TempDir(), "enterprise.json")
	t.Setenv("HOME", home)
	writeJSON(t, filepath.Join(home, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"baseDirectory": "/global", "profileName": "global"},
	})
	writeJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"baseDirectory": "/project", "profileName": "project"},
	})
	if got := ResolveNewConversationDefaults(project); got.BaseDirectory != "/project" || got.ProfileName != "project" {
		t.Fatalf("project defaults = %+v", got)
	}
	writeJSON(t, enterprise, map[string]any{
		"newConversationDefaults": map[string]any{"baseDirectory": "/enterprise", "profileName": "enterprise", "profileLocked": true},
	})
	t.Setenv("ION_ENTERPRISE_CONFIG", enterprise)
	if got := ResolveNewConversationDefaults(project); got.BaseDirectory != "/enterprise" || got.ProfileName != "enterprise" || !got.ProfileLocked {
		t.Fatalf("enterprise defaults = %+v", got)
	}
}

func TestManagedProjects_ExpandsAndRejectsAmbiguousRecords(t *testing.T) {
	home := t.TempDir()
	enterprise := filepath.Join(t.TempDir(), "enterprise.json")
	t.Setenv("HOME", home)
	t.Setenv("ION_ENTERPRISE_CONFIG", enterprise)
	writeJSON(t, enterprise, map[string]any{
		"newConversationDefaults": map[string]any{"projects": []map[string]any{{"directory": "~/managed", "name": "Managed", "default": true, "profileName": "corp", "profileLocked": true}}},
	})
	projects := ManagedProjects()
	if len(projects) != 1 || projects[0].Directory != filepath.Join(home, "managed") || !projects[0].ProfileLocked {
		t.Fatalf("managed projects = %#v", projects)
	}
	writeJSON(t, enterprise, map[string]any{
		"newConversationDefaults": map[string]any{"projects": []map[string]any{{"directory": "/same"}, {"directory": "/same"}}},
	})
	if projects := ManagedProjects(); projects != nil {
		t.Fatalf("duplicate managed records must be refused, got %#v", projects)
	}
}

func TestResolveNewConversationDefaults_ManagedProjectOverridesProfile(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	enterprise := filepath.Join(t.TempDir(), "enterprise.json")
	t.Setenv("HOME", home)
	t.Setenv("ION_ENTERPRISE_CONFIG", enterprise)
	writeJSON(t, filepath.Join(home, ".ion", "settings.json"), map[string]any{
		"engineProfiles": []map[string]any{{"id": "corp-id", "name": "corp", "extensions": []string{"/corp"}}},
	})
	writeJSON(t, enterprise, map[string]any{
		"newConversationDefaults": map[string]any{"projects": []map[string]any{{"directory": project, "profileName": "corp", "profileLocked": true}}},
	})
	got := ResolveNewConversationDefaults(project)
	if got.ProfileID != "corp-id" || !got.ProfileLocked {
		t.Fatalf("managed Project defaults = %#v", got)
	}
}

func TestApplyNewConversationDefaults_ProfileLockReplacesCallerProfile(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("HOME", home)
	writeJSON(t, filepath.Join(home, ".ion", "settings.json"), map[string]any{
		"engineProfiles": []map[string]any{{"id": "locked-id", "name": "locked", "extensions": []string{"/locked-extension"}}},
	})
	writeJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"profileName": "locked", "profileLocked": true},
	})

	got, err := ApplyNewConversationDefaults(types.EngineConfig{WorkingDirectory: project, ProfileID: "caller", Extensions: []string{"/caller-extension"}})
	if err != nil {
		t.Fatal(err)
	}
	if got.ProfileID != "locked-id" || len(got.Extensions) != 1 || got.Extensions[0] != "/locked-extension" {
		t.Fatalf("lock did not replace caller profile: %+v", got)
	}
}

func TestApplyNewConversationDefaults_UnknownLockedProfileRefusesStart(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("HOME", home)
	writeJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"profileName": "missing", "profileLocked": true},
	})
	if _, err := ApplyNewConversationDefaults(types.EngineConfig{WorkingDirectory: project}); err == nil {
		t.Fatal("expected locked unknown profile to be refused")
	}
}
