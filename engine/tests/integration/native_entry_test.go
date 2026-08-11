//go:build integration

package integration

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// nativeMainScript is a POSIX-shell "native binary": no .ts/.js extension, so
// the engine spawns it directly rather than routing it through node. It
// answers the init handshake with one registered tool and then idles on stdin.
const nativeMainScript = `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"init"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"name":"native-entry-test","tools":[{"name":"native_echo","description":"echo from a native binary","parameters":{"type":"object","properties":{}}}],"commands":{}}}\n' "$id"
      ;;
  esac
done
`

// TestNativeEntry_ExecutableMainLoadsByDirectory pins the documented promise in
// docs/extensions/sdk-raw.md: an extension compiled to a binary named "main"
// in the extension directory loads when the host is given the *directory*.
// Before the resolveExtensionEntry fix this failed with "no extension entry
// point in <dir>", because only script candidates were probed.
func TestNativeEntry_ExecutableMainLoadsByDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell entry point is not executable on windows")
	}
	extDir := t.TempDir()
	mainPath := filepath.Join(extDir, "main")
	if err := os.WriteFile(mainPath, []byte(nativeMainScript), 0o755); err != nil {
		t.Fatalf("write native main: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	done := make(chan error, 1)
	go func() {
		done <- host.Load(extDir, &extension.ExtensionConfig{
			ExtensionDir:     extDir,
			WorkingDirectory: extDir,
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load(directory with executable main): %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Load timed out waiting for the native init handshake")
	}

	if got := host.Name(); got != "native-entry-test" {
		t.Errorf("init handshake name = %q, want native-entry-test", got)
	}

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("registered tools = %d, want 1 (%+v)", len(tools), tools)
	}
	if tools[0].Name != "native_echo" {
		t.Errorf("tool name = %q, want native_echo", tools[0].Name)
	}
}

// TestNativeEntry_NonExecutableMainIsRejected pins the executable-bit
// requirement end to end: a "main" file without the executable bit must fail
// at entry resolution with a descriptive error, not at spawn time with a bare
// EACCES far from the decision that caused it.
func TestNativeEntry_NonExecutableMainIsRejected(t *testing.T) {
	extDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(extDir, "main"), []byte(nativeMainScript), 0o644); err != nil {
		t.Fatalf("write non-executable main: %v", err)
	}

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	err := host.Load(extDir, &extension.ExtensionConfig{
		ExtensionDir:     extDir,
		WorkingDirectory: extDir,
	})
	if err == nil {
		t.Fatal("expected Load to fail for a non-executable main")
	}
}
