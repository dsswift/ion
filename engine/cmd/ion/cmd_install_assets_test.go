package main

import (
	"os"
	"path/filepath"
	"testing"
)

// buildFakeAssetTree creates a minimal asset tree under root that mirrors the
// layout the install-assets subcommand expects:
//
//	root/
//	  extensions/
//	    sdk/            (a few files)
func buildFakeAssetTree(t *testing.T, root string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "extensions", "sdk"), 0o755); err != nil {
		t.Fatalf("mkdir sdk: %v", err)
	}
	files := map[string]string{
		"extensions/sdk/index.js":   "// sdk stub",
		"extensions/sdk/types.d.ts": "// types stub",
	}
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
}

// TestInstallAssets_CopiesSDK verifies that cmdInstallAssets (via its
// constituent helpers) copies extensions/sdk into the target ion home.
func TestInstallAssets_CopiesSDK(t *testing.T) {
	assetRoot := t.TempDir()
	buildFakeAssetTree(t, assetRoot)

	ionHome := t.TempDir()

	sdkSrc := filepath.Join(assetRoot, "extensions", "sdk")
	sdkDst := filepath.Join(ionHome, "extensions", "sdk")
	if err := copyDirContents(sdkSrc, sdkDst); err != nil {
		t.Fatalf("copyDirContents sdk: %v", err)
	}

	for _, rel := range []string{"index.js", "types.d.ts"} {
		if _, err := os.Stat(filepath.Join(sdkDst, rel)); err != nil {
			t.Errorf("sdk file %q missing: %v", rel, err)
		}
	}
}

// TestFindAssetRoot_DevLayout verifies findAssetRoot walks up from the binary
// directory to locate the extensions/ tree (dev build layout: binary at
// engine/bin/ion, extensions at engine/extensions/).
func TestFindAssetRoot_DevLayout(t *testing.T) {
	// Build: root/extensions/ root/subdir/binary
	root := t.TempDir()
	binDir := filepath.Join(root, "subdir")
	if err := os.MkdirAll(filepath.Join(root, "extensions"), 0o755); err != nil {
		t.Fatalf("mkdir extensions: %v", err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir binDir: %v", err)
	}

	found, err := findAssetRoot(binDir)
	if err != nil {
		t.Fatalf("findAssetRoot: %v", err)
	}
	if found != root {
		t.Errorf("findAssetRoot: got %q want %q", found, root)
	}
}

// TestFindAssetRoot_PackagedLayout verifies findAssetRoot finds extensions/
// when it sits alongside the binary (packaged layout).
func TestFindAssetRoot_PackagedLayout(t *testing.T) {
	// Build: binDir/extensions/  binDir/binary
	binDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(binDir, "extensions"), 0o755); err != nil {
		t.Fatalf("mkdir extensions: %v", err)
	}

	found, err := findAssetRoot(binDir)
	if err != nil {
		t.Fatalf("findAssetRoot: %v", err)
	}
	if found != binDir {
		t.Errorf("findAssetRoot: got %q want %q", found, binDir)
	}
}

// TestFindAssetRoot_NotFound verifies that findAssetRoot returns an error when
// no extensions/ tree is present in the search path.
func TestFindAssetRoot_NotFound(t *testing.T) {
	emptyDir := t.TempDir()
	_, err := findAssetRoot(emptyDir)
	if err == nil {
		t.Error("expected error when extensions/ not found, got nil")
	}
}

// TestReplaceDirContents_RemovesOrphans pins the replace (not merge)
// semantics of SDK installation. Regression for the stale-SDK
// defect: a merge-copy left orphaned files (including a nested sdk/sdk
// directory created by an earlier `cp -r` staging bug) in
// ~/.ion/extensions/sdk across every upgrade, so extensions loaded an SDK
// runtime frozen at the first-ever install. This test fails on the old
// copyDirContents-based install: the orphan survives a merge.
func TestReplaceDirContents_RemovesOrphans(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()

	// Fresh source ships one file.
	if err := os.WriteFile(filepath.Join(src, "runtime.ts"), []byte("fresh"), 0o644); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	// Destination carries a stale file, plus a nested stale dir (the exact
	// shape the cp -r bug produced).
	if err := os.WriteFile(filepath.Join(dst, "runtime.ts"), []byte("stale"), 0o644); err != nil {
		t.Fatalf("seed dst: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dst, "sdk", "ion-sdk"), 0o755); err != nil {
		t.Fatalf("seed nested: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dst, "sdk", "ion-sdk", "runtime.ts"), []byte("nested-stale"), 0o644); err != nil {
		t.Fatalf("seed nested file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dst, "orphan.ts"), []byte("deleted upstream"), 0o644); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}

	if err := replaceDirContents(src, dst); err != nil {
		t.Fatalf("replaceDirContents: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dst, "runtime.ts"))
	if err != nil {
		t.Fatalf("read replaced file: %v", err)
	}
	if string(got) != "fresh" {
		t.Errorf("runtime.ts = %q, want the fresh source copy", got)
	}
	if _, err := os.Stat(filepath.Join(dst, "sdk")); !os.IsNotExist(err) {
		t.Error("nested stale sdk/ directory survived the replace")
	}
	if _, err := os.Stat(filepath.Join(dst, "orphan.ts")); !os.IsNotExist(err) {
		t.Error("orphaned file survived the replace")
	}
}
