package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// cmdInstallAssets replicates the SDK / ion-meta / canonical-docs sections of
// commands/install.command for the DMG/package install route, which has no
// shell installer. It must be called after the engine binary is in place
// (e.g. by the macOS installer package post-install script).
//
// Source asset resolution:
//  1. Relative to the directory containing the running executable — this is
//     the layout used inside a packaged .app bundle where extensions/ ships
//     alongside the binary.
//  2. Fallback: walk up from the executable directory looking for a
//     "extensions" directory, to support repo-relative dev builds where the
//     binary lives at engine/bin/ion and extensions live at engine/extensions/.
//
// Actions (mirrors install.command lines 74-122):
//  1. Copy extensions/sdk       → ~/.ion/extensions/sdk
//  2. Copy extensions/ion-meta  → ~/.ion/extensions/ion-meta
//  3. Rebuild canonical docs in ~/.ion/extensions/ion-meta/docs/canonical/
//     from docs/{extensions,hooks,agents,architecture} — delete first so
//     renames/deletions propagate.
func cmdInstallAssets() {
	exeDir, err := resolveExeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: locate executable: %v\n", err)
		os.Exit(1)
	}

	assetRoot, err := findAssetRoot(exeDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: %v\n", err)
		os.Exit(1)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: home dir: %v\n", err)
		os.Exit(1)
	}
	ionHome := filepath.Join(home, ".ion")

	// 1. Install SDK — replace, don't merge. The installed copy is
	// "overwritten at build time" by contract (root CLAUDE.md § Extension
	// SDK source location); a merge-copy leaves orphaned files (deleted or
	// renamed SDK modules, stray nested directories from older staging
	// bugs) that shadow the real surface forever.
	sdkSrc := filepath.Join(assetRoot, "extensions", "sdk")
	sdkDst := filepath.Join(ionHome, "extensions", "sdk")
	if err := replaceDirContents(sdkSrc, sdkDst); err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: install SDK: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("==> Installed extension SDK to %s\n", sdkDst)

	// 2. Install ion-meta — same replace semantics: it ships with the
	// engine and holds no user state (runtime state lives outside the
	// extension dir), so renames/deletions must propagate like the
	// canonical docs below.
	metaSrc := filepath.Join(assetRoot, "extensions", "ion-meta")
	metaDst := filepath.Join(ionHome, "extensions", "ion-meta")
	if err := replaceDirContents(metaSrc, metaDst); err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: install ion-meta: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("==> Installed ion-meta extension to %s\n", metaDst)

	// 3. Rebuild canonical docs.
	// Docs source: one level above assetRoot for the packaged layout
	// (assetRoot = .app/.../MacOS, docs would be next to the app), but in
	// practice for the package route the docs are not shipped separately —
	// they are embedded in the ion-meta extension itself if present. For the
	// dev/repo layout we resolve from assetRoot/../../../docs.
	// Try the sibling-of-assetRoot path first, then repo-relative fallback.
	docsRoot := findDocsRoot(assetRoot)
	canonDst := filepath.Join(metaDst, "docs", "canonical")
	if docsRoot != "" {
		if err := rebuildCanonicalDocs(docsRoot, canonDst); err != nil {
			fmt.Fprintf(os.Stderr, "install-assets: canonical docs: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("==> Bundled canonical docs into %s\n", canonDst)
	} else {
		fmt.Println("==> No docs source found; skipping canonical docs (ok for packaged builds)")
	}

	fmt.Println("==> install-assets complete")
}

// resolveExeDir returns the directory of the running executable, following
// any symlinks.
func resolveExeDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}

// findAssetRoot locates the directory that contains an "extensions" subtree.
// It first checks startDir itself, then walks up to three parent levels. This
// covers:
//   - Packaged .app: binary at .../MacOS/ion, extensions at .../MacOS/extensions/
//   - Dev repo:      binary at engine/bin/ion, extensions at engine/extensions/
func findAssetRoot(startDir string) (string, error) {
	dir := startDir
	for i := 0; i <= 3; i++ {
		candidate := filepath.Join(dir, "extensions")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break // filesystem root
		}
		dir = parent
	}
	return "", fmt.Errorf("extensions directory not found starting from %s (checked up to %d parents)", startDir, 3)
}

// findDocsRoot locates the repo docs/ directory.  In a dev build the repo
// root is typically two to four levels above the binary directory. Returns ""
// when not found (packaged build without a separate docs tree).
func findDocsRoot(assetRoot string) string {
	dir := assetRoot
	for i := 0; i <= 4; i++ {
		candidate := filepath.Join(dir, "docs")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			// Confirm it has at least one of the expected namespaces.
			for _, ns := range []string{"extensions", "hooks", "agents", "architecture"} {
				if sub, err := os.Stat(filepath.Join(candidate, ns)); err == nil && sub.IsDir() {
					return candidate
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// copyDirContents copies all contents of src into dst, creating dst if it
// does not exist. Mirrors `mkdir -p "$DST" && cp -r "$SRC"/* "$DST/"`.
// Returns a non-nil error if src does not exist (the install.command uses an
// `if [[ -d "$SRC" ]]` guard; we treat a missing source as an error so
// callers know the asset was not bundled).
// replaceDirContents deletes dst then copies src into place, so the
// destination is an exact mirror of the source. Used for engine-shipped
// assets (SDK, ion-meta) where merge-copy semantics would leave orphaned
// files behind across upgrades.
func replaceDirContents(src, dst string) error {
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("source %q not found: %w", src, err)
	}
	if err := os.RemoveAll(dst); err != nil {
		return fmt.Errorf("remove stale %q: %w", dst, err)
	}
	return copyDirContents(src, dst)
}

func copyDirContents(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("source %q not found: %w", src, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("source %q is not a directory", src)
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return fmt.Errorf("create %q: %w", dst, err)
	}
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

// rebuildCanonicalDocs deletes canonDst and repopulates it from the four
// allow-listed namespaces in docsRoot. Mirrors install.command lines 109-122.
func rebuildCanonicalDocs(docsRoot, canonDst string) error {
	// Delete first so renames/deletions in the source propagate.
	if err := os.RemoveAll(canonDst); err != nil {
		return fmt.Errorf("remove canonical tree: %w", err)
	}
	if err := os.MkdirAll(canonDst, 0o755); err != nil {
		return fmt.Errorf("create canonical dir: %w", err)
	}

	namespaces := []string{"extensions", "hooks", "agents", "architecture"}
	for _, ns := range namespaces {
		srcNs := filepath.Join(docsRoot, ns)
		if info, err := os.Stat(srcNs); err != nil || !info.IsDir() {
			continue // namespace absent — skip silently (mirrors the bash `if [[ -d ]]` guard)
		}
		dstNs := filepath.Join(canonDst, ns)
		if err := copyDirContents(srcNs, dstNs); err != nil {
			return fmt.Errorf("copy namespace %q: %w", ns, err)
		}
	}
	return nil
}

// copyFile copies a single regular file from src to dst, preserving
// permissions.
func copyFile(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, info.Mode())
}
