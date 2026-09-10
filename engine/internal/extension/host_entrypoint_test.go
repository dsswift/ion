package extension

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// minimalExtensionSrc is a bare NDJSON extension that answers the init
// handshake and then idles. Enough to prove Load succeeds end-to-end.
const minimalExtensionSrc = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.method === 'init') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'entry-test' } }) + '\n');
    return;
  }
});
setInterval(() => {}, 1000);
`

// TestResolveExtensionEntry_CandidateOrder pins the conventional entry-point
// search: extension.ts wins over index.ts, TS wins over JS, and a directory
// with no candidate yields a descriptive error naming the probed files.
func TestResolveExtensionEntry_CandidateOrder(t *testing.T) {
	t.Run("extension_ts_wins_over_index_ts", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "extension.ts"), "// ext")
		mustWrite(t, filepath.Join(dir, "index.ts"), "// idx")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != "extension.ts" {
			t.Errorf("entry = %s, want extension.ts", entry)
		}
	})

	t.Run("index_ts_when_no_extension_ts", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "index.ts"), "// idx")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != "index.ts" {
			t.Errorf("entry = %s, want index.ts", entry)
		}
	})

	t.Run("js_fallback", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "index.js"), "// js")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != "index.js" {
			t.Errorf("entry = %s, want index.js", entry)
		}
	})

	t.Run("executable_main_resolves", func(t *testing.T) {
		dir := t.TempDir()
		mustWriteExecutable(t, filepath.Join(dir, nativeEntryName), "#!/bin/sh\nexit 0\n")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != nativeEntryName {
			t.Errorf("entry = %s, want %s", entry, nativeEntryName)
		}
	})

	t.Run("index_ts_beats_main", func(t *testing.T) {
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, "index.ts"), "// idx")
		mustWriteExecutable(t, filepath.Join(dir, nativeEntryName), "#!/bin/sh\nexit 0\n")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != "index.ts" {
			t.Errorf("entry = %s, want index.ts (script candidates take precedence)", entry)
		}
	})

	t.Run("non_executable_main_does_not_resolve_on_unix", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("windows has no exec-bit concept; a plain main.exe always resolves")
		}
		dir := t.TempDir()
		mustWrite(t, filepath.Join(dir, nativeEntryName), "not executable")
		_, err := resolveExtensionEntry(dir)
		if err == nil {
			t.Fatal("expected error: a non-executable main must not resolve")
		}
		if !strings.Contains(err.Error(), nativeEntryName) {
			t.Errorf("error should name %s among probed candidates, got %q", nativeEntryName, err.Error())
		}
	})

	t.Run("main_directory_does_not_resolve", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, nativeEntryName), 0o755); err != nil {
			t.Fatal(err)
		}
		_, err := resolveExtensionEntry(dir)
		if err == nil {
			t.Fatal("expected error: a directory named main must not resolve")
		}
	})

	t.Run("no_candidate_is_descriptive_error", func(t *testing.T) {
		dir := t.TempDir()
		_, err := resolveExtensionEntry(dir)
		if err == nil {
			t.Fatal("expected error for empty directory")
		}
		if !strings.Contains(err.Error(), dir) || !strings.Contains(err.Error(), "extension.ts") {
			t.Errorf("error should name the directory and candidates, got %q", err.Error())
		}
	})

	t.Run("subdirectory_named_like_candidate_is_skipped", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.MkdirAll(filepath.Join(dir, "extension.ts"), 0o755); err != nil {
			t.Fatal(err)
		}
		mustWrite(t, filepath.Join(dir, "index.js"), "// js")
		entry, err := resolveExtensionEntry(dir)
		if err != nil {
			t.Fatalf("resolveExtensionEntry: %v", err)
		}
		if filepath.Base(entry) != "index.js" {
			t.Errorf("entry = %s, want index.js (dir candidate must be skipped)", entry)
		}
	})
}

// TestHostLoad_DirectoryResolvesEntryPoint pins the regression that broke
// harness lead→specialist delegation: DispatchAgentOpts.ExtensionDir is a
// directory (by name and by SDK convention: ctx.config.extensionDir), but
// Host.Load rejected directories outright — so loadChildExtension failed on
// every dispatch and the child never received its extension (persona, hooks,
// or tools). On the unfixed code this Load returns "expected extension file,
// got directory" and the test fails.
func TestHostLoad_DirectoryResolvesEntryPoint(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "index.js"), minimalExtensionSrc)

	h := NewHost()
	// Registered before the select, not after: t.Fatal on the timeout branch
	// below calls runtime.Goexit() immediately, which would skip a Cleanup
	// registered afterward -- leaving the background goroutine's still-Loading
	// subprocess (and its open handle on a file under t.TempDir()) to outlive
	// the test. That is what turned a single timeout into a second, unrelated
	// failure: "TempDir RemoveAll cleanup: ... being used by another process."
	t.Cleanup(func() { h.Dispose() })
	done := make(chan error, 1)
	go func() { done <- h.Load(dir, &ExtensionConfig{ExtensionDir: dir, WorkingDirectory: dir}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Load(directory) failed: %v", err)
		}
	case <-time.After(90 * time.Second):
		// 90s, not 30s: this passes in under a second in isolation (verified
		// on real Windows), but real Windows CI hit 31.79s under go test
		// -race ./... contention -- many packages spawning node/PowerShell
		// subprocesses concurrently, plus the race detector's own per-access
		// overhead slowing an already-cold node startup. The 30s bound was
		// exercising CI scheduling noise, not this code path.
		t.Fatal("Load timed out")
	}

	if h.Name() != "entry-test" {
		t.Errorf("init handshake did not complete: name = %q", h.Name())
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// mustWriteExecutable writes a file with the executable bit set. The native
// entry-point probe requires mode&0111, so tests covering "main" resolution
// cannot use mustWrite.
func mustWriteExecutable(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
