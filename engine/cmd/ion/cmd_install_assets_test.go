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
//	    ion-meta/       (a few files + docs/canonical placeholder)
//	  docs/
//	    extensions/     (canonical namespace)
//	    hooks/
//	    agents/
//	    architecture/
func buildFakeAssetTree(t *testing.T, root string) {
	t.Helper()
	dirs := []string{
		"extensions/sdk",
		"extensions/ion-meta/docs/canonical",
		"docs/extensions",
		"docs/hooks",
		"docs/agents",
		"docs/architecture/adr",
	}
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	files := map[string]string{
		"extensions/sdk/index.js":            "// sdk stub",
		"extensions/sdk/types.d.ts":          "// types stub",
		"extensions/ion-meta/manifest.json":  `{"name":"ion-meta"}`,
		"extensions/ion-meta/index.js":       "// ion-meta stub",
		"docs/extensions/overview.md":        "# Extensions",
		"docs/hooks/session_start.md":        "# session_start",
		"docs/agents/overview.md":            "# Agents",
		"docs/architecture/adr/ADR-001.md":   "# ADR-001",
	}
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
}

// TestInstallAssets_CopiesSDKAndMeta verifies that cmdInstallAssets (via its
// constituent helpers) copies extensions/sdk and extensions/ion-meta into the
// target ion home directory.
func TestInstallAssets_CopiesSDKAndMeta(t *testing.T) {
	assetRoot := t.TempDir()
	buildFakeAssetTree(t, assetRoot)

	ionHome := t.TempDir()

	sdkSrc := filepath.Join(assetRoot, "extensions", "sdk")
	sdkDst := filepath.Join(ionHome, "extensions", "sdk")
	if err := copyDirContents(sdkSrc, sdkDst); err != nil {
		t.Fatalf("copyDirContents sdk: %v", err)
	}

	metaSrc := filepath.Join(assetRoot, "extensions", "ion-meta")
	metaDst := filepath.Join(ionHome, "extensions", "ion-meta")
	if err := copyDirContents(metaSrc, metaDst); err != nil {
		t.Fatalf("copyDirContents ion-meta: %v", err)
	}

	// Assert sdk files landed.
	for _, rel := range []string{"index.js", "types.d.ts"} {
		if _, err := os.Stat(filepath.Join(sdkDst, rel)); err != nil {
			t.Errorf("sdk file %q missing: %v", rel, err)
		}
	}

	// Assert ion-meta files landed.
	for _, rel := range []string{"manifest.json", "index.js"} {
		if _, err := os.Stat(filepath.Join(metaDst, rel)); err != nil {
			t.Errorf("ion-meta file %q missing: %v", rel, err)
		}
	}
}

// TestInstallAssets_RebuildCanonicalDocs verifies that rebuildCanonicalDocs:
//   - deletes any pre-existing canonical tree
//   - copies all four allowed namespaces (extensions, hooks, agents, architecture)
//   - propagates deletions (a file removed from source is absent after rebuild)
func TestInstallAssets_RebuildCanonicalDocs(t *testing.T) {
	assetRoot := t.TempDir()
	buildFakeAssetTree(t, assetRoot)

	canonDst := filepath.Join(t.TempDir(), "canonical")

	// Pre-seed a stale file that should be deleted on rebuild.
	staleDir := filepath.Join(canonDst, "stale-namespace")
	if err := os.MkdirAll(staleDir, 0o755); err != nil {
		t.Fatalf("mkdir stale: %v", err)
	}
	staleFile := filepath.Join(staleDir, "old.md")
	if err := os.WriteFile(staleFile, []byte("old"), 0o644); err != nil {
		t.Fatalf("write stale: %v", err)
	}

	docsRoot := filepath.Join(assetRoot, "docs")
	if err := rebuildCanonicalDocs(docsRoot, canonDst); err != nil {
		t.Fatalf("rebuildCanonicalDocs: %v", err)
	}

	// Stale tree must be gone.
	if _, err := os.Stat(staleFile); err == nil {
		t.Error("stale file survived rebuild; renames/deletions do not propagate")
	}

	// All four canonical namespaces must be present.
	for _, ns := range []string{"extensions", "hooks", "agents", "architecture"} {
		nsPath := filepath.Join(canonDst, ns)
		if info, err := os.Stat(nsPath); err != nil || !info.IsDir() {
			t.Errorf("canonical namespace %q missing after rebuild", ns)
		}
	}

	// Spot-check specific files inside each namespace.
	checks := map[string]string{
		"extensions/overview.md":      "# Extensions",
		"hooks/session_start.md":      "# session_start",
		"agents/overview.md":          "# Agents",
		"architecture/adr/ADR-001.md": "# ADR-001",
	}
	for rel, wantContent := range checks {
		path := filepath.Join(canonDst, rel)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("canonical file %q missing: %v", rel, err)
			continue
		}
		if string(data) != wantContent {
			t.Errorf("canonical file %q: got %q want %q", rel, data, wantContent)
		}
	}
}

// TestInstallAssets_CanonicalDeletePropagation rebuilds twice and verifies
// that a file present in the first build but absent from the source in the
// second build is removed. This pins the "delete first, then copy" contract.
func TestInstallAssets_CanonicalDeletePropagation(t *testing.T) {
	assetRoot := t.TempDir()
	buildFakeAssetTree(t, assetRoot)

	canonDst := filepath.Join(t.TempDir(), "canonical")
	docsRoot := filepath.Join(assetRoot, "docs")

	// First build — all namespaces present.
	if err := rebuildCanonicalDocs(docsRoot, canonDst); err != nil {
		t.Fatalf("first rebuild: %v", err)
	}
	if _, err := os.Stat(filepath.Join(canonDst, "hooks")); err != nil {
		t.Fatalf("hooks present after first build: %v", err)
	}

	// Remove hooks from the source to simulate a namespace being dropped.
	if err := os.RemoveAll(filepath.Join(docsRoot, "hooks")); err != nil {
		t.Fatalf("remove hooks source: %v", err)
	}

	// Second build — hooks namespace should no longer exist in canonical.
	if err := rebuildCanonicalDocs(docsRoot, canonDst); err != nil {
		t.Fatalf("second rebuild: %v", err)
	}
	if _, err := os.Stat(filepath.Join(canonDst, "hooks")); err == nil {
		t.Error("hooks survived rebuild after being removed from source; delete-first contract broken")
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
// semantics of SDK / ion-meta installation. Regression for the stale-SDK
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
