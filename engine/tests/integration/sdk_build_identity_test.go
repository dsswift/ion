//go:build integration

package integration

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

// TestSDKBuildIdentity_RealTypeScriptInit proves the TypeScript runtime reports
// its installed build stamp for provenance without coupling extension loading
// to the engine build that happens to host it.
func TestSDKBuildIdentity_RealTypeScriptInit(t *testing.T) {
	requireEsbuild(t)

	home := t.TempDir()
	identity := "sdk-init-integration-build"
	stampDir := filepath.Join(home, ".ion", "extensions", "sdk", "ion-sdk")
	if err := os.MkdirAll(stampDir, 0o755); err != nil {
		t.Fatalf("create SDK stamp directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stampDir, "build-identity.json"), []byte(`{"buildIdentity":"`+identity+`"}`), 0o644); err != nil {
		t.Fatalf("write SDK build identity: %v", err)
	}

	oldHome, hadHome := os.LookupEnv("HOME")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatalf("set HOME: %v", err)
	}
	t.Cleanup(func() {
		if hadHome {
			if err := os.Setenv("HOME", oldHome); err != nil {
				t.Errorf("restore HOME: %v", err)
			}
			return
		}
		if err := os.Unsetenv("HOME"); err != nil {
			t.Errorf("unset HOME: %v", err)
		}
	})

	extDir := t.TempDir()
	sdkPath, err := filepath.Abs(filepath.Join("..", "..", "extensions", "sdk", "ion-sdk"))
	if err != nil {
		t.Fatalf("resolve SDK path: %v", err)
	}
	entry := filepath.Join(extDir, "index.ts")
	code := "import { createIon } from '" + sdkPath + "'\n" +
		"const ion = createIon()\n" +
		"ion.registerTool({ name: 'identity_probe', description: 'identity probe', parameters: { type: 'object', properties: {} }, execute: () => ({ content: 'ok' }) })\n"
	if err := os.WriteFile(entry, []byte(code), 0o644); err != nil {
		t.Fatalf("write TypeScript extension: %v", err)
	}

	host := extension.NewHost()
	host.SetEngineBuildIdentity(identity)
	t.Cleanup(host.Dispose)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: extDir,
	}); err != nil {
		t.Fatalf("Load TypeScript extension with matching build identity: %v", err)
	}

	if !hasToolNamed(host.Tools(), "identity_probe") {
		t.Errorf("TypeScript init did not register identity_probe: %v", toolNames(host.Tools()))
	}

	mismatchedHost := extension.NewHost()
	mismatchedHost.SetEngineBuildIdentity("different-engine-build")
	t.Cleanup(mismatchedHost.Dispose)
	if err := mismatchedHost.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: extDir,
	}); err != nil {
		t.Fatalf("independently deployed TypeScript SDK was rejected: %v", err)
	}
	if !hasToolNamed(mismatchedHost.Tools(), "identity_probe") {
		t.Fatal("mismatched SDK identity prevented compatible tool registration")
	}
}

func hasToolNamed(tools []extension.ToolDefinition, name string) bool {
	for _, tool := range tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
