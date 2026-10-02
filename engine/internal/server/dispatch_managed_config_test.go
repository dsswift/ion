package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/types"
)

// managedResult finds the result line for requestID and decodes it.
func managedResult(t *testing.T, lines []string, requestID string) map[string]json.RawMessage {
	t.Helper()
	for _, line := range lines {
		var result map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &result) != nil {
			continue
		}
		var id string
		if json.Unmarshal(result["requestId"], &id) == nil && id == requestID {
			return result
		}
	}
	t.Fatalf("no result for %q in %v", requestID, lines)
	return nil
}

// projectManagedModels points enterprise policy at a managed models file.
func projectManagedModels(t *testing.T, managedJSON string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	managedPath := filepath.Join(dir, "models.managed.json")
	if err := os.WriteFile(managedPath, []byte(managedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	policy, err := json.Marshal(types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{ModelsPath: managedPath, SchemaVersion: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(dir, "enterprise.json")
	if err := os.WriteFile(policyPath, policy, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", policyPath)
}

func TestSetModelTier_ManagedSurface_RefusedWithCode(t *testing.T) {
	projectManagedModels(t, `{"tiers":{"fast":"managed-fast"}}`)
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "set_model_tier", "requestId": "set", "text": "fast", "model": "other-model",
	})
	result := managedResult(t, readLines(t, conn, 3, 2*time.Second), "set")
	if string(result["ok"]) != "false" {
		t.Fatalf("ok = %s, want false", result["ok"])
	}
	var code string
	if err := json.Unmarshal(result["code"], &code); err != nil || code != ionconfig.ManagedConfigWriteRefusedCode {
		t.Fatalf("code = %s, want %q", result["code"], ionconfig.ManagedConfigWriteRefusedCode)
	}
}

func TestGetManagedConfigStatus_ReportsAppliedAndCurrentWithoutContent(t *testing.T) {
	const managed = `{"tiers":{"fast":"secret-routing-detail"}}`
	projectManagedModels(t, managed)
	srv := newShortPathTestServer(t, newMockBackend())
	// What the engine loaded at start: an older managed file.
	srv.SetConfig(&types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			ManagedConfigStatus: &types.ManagedConfigStatus{
				SchemaVersion: 1, SupportedSchemaVersion: 1,
				Models: &types.ManagedSurfaceStatus{Projected: true, Checksum: "sha256:loaded-at-start"},
			},
		},
	})
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{"cmd": "get_managed_config_status", "requestId": "status"})
	lines := readLines(t, conn, 3, 2*time.Second)
	result := managedResult(t, lines, "status")
	var data struct {
		Applied *types.ManagedConfigStatus `json:"applied"`
		Current *types.ManagedConfigStatus `json:"current"`
	}
	if err := json.Unmarshal(result["data"], &data); err != nil {
		t.Fatalf("decode data: %v", err)
	}
	if data.Applied == nil || data.Applied.Models == nil || data.Applied.Models.Checksum != "sha256:loaded-at-start" {
		t.Errorf("applied = %+v, want the status loaded at start", data.Applied)
	}
	if data.Current == nil || data.Current.Models == nil || !data.Current.Models.Projected {
		t.Fatalf("current = %+v, want a projected models surface", data.Current)
	}
	if !strings.HasPrefix(data.Current.Models.Checksum, "sha256:") || data.Current.Models.Checksum == "sha256:loaded-at-start" {
		t.Errorf("current checksum = %q, want the file's digest", data.Current.Models.Checksum)
	}
	if data.Current.SchemaVersion != 1 {
		t.Errorf("current schemaVersion = %d, want 1", data.Current.SchemaVersion)
	}
	if strings.Contains(strings.Join(lines, "\n"), "secret-routing-detail") {
		t.Error("status response carries managed file content")
	}
}

func TestGetManagedConfigStatus_NoManagedSource(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{"cmd": "get_managed_config_status", "requestId": "status"})
	result := managedResult(t, readLines(t, conn, 3, 2*time.Second), "status")
	if got := string(result["data"]); got != `{"applied":null,"current":null}` {
		t.Errorf("data = %s, want null applied and current", got)
	}
}
