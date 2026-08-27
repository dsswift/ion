package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestStartSession_ProfileLockOverridesClientProfile(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("HOME", home)
	writeSessionJSON(t, filepath.Join(home, ".ion", "settings.json"), map[string]any{
		"engineProfiles": []map[string]any{{"id": "managed-id", "name": "managed", "extensions": []string{}}},
	})
	writeSessionJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"profileName": "managed", "profileLocked": true},
	})

	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	if _, err := mgr.StartSession("locked-profile", types.EngineConfig{WorkingDirectory: project, ProfileID: "caller", Extensions: []string{"/caller"}}); err != nil {
		t.Fatal(err)
	}
	mgr.mu.RLock()
	got := mgr.sessions["locked-profile"].config
	mgr.mu.RUnlock()
	if got.ProfileID != "managed-id" || len(got.Extensions) != 0 {
		t.Fatalf("session config bypassed profile lock: %+v", got)
	}
}

func TestStartSession_UnknownLockedProfileRefusesSession(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("HOME", home)
	writeSessionJSON(t, filepath.Join(project, ".ion", "engine.json"), map[string]any{
		"newConversationDefaults": map[string]any{"profileName": "missing", "profileLocked": true},
	})

	mgr := NewManager(newMockBackend())
	t.Cleanup(mgr.Shutdown)
	if _, err := mgr.StartSession("missing-locked-profile", types.EngineConfig{WorkingDirectory: project}); err == nil {
		t.Fatal("expected locked unknown profile to refuse start_session")
	}
	if len(mgr.ListSessions()) != 0 {
		t.Fatal("refused start_session must not create a session")
	}
}

func writeSessionJSON(t *testing.T, path string, value any) {
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
