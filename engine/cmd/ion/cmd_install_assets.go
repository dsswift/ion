package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// cmdInstallAssets replicates the SDK section of commands/install.command for
// the DMG/package install route, which has no shell installer. It must be
// called after the engine binary is in place (e.g. by the macOS installer
// package post-install script).
//
// Source asset resolution:
//  1. Relative to the directory containing the running executable — this is
//     the layout used inside a packaged .app bundle where extensions/ ships
//     alongside the binary.
//  2. Fallback: walk up from the executable directory looking for a
//     "extensions" directory, to support repo-relative dev builds where the
//     binary lives at engine/bin/ion and extensions live at engine/extensions/.
//
// Action: copy extensions/sdk → ~/.ion/extensions/sdk (replace semantics).
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

	// Install SDK — replace, don't merge. The installed copy is
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

	// Stamp the engine's build identity into the installed SDK so the
	// subprocess can report it back during the init handshake. The engine
	// validates this against its own identity to detect mixed-build runtimes.
	if err := stampBuildIdentity(sdkDst); err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: stamp build identity: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("==> Installed extension SDK to %s\n", sdkDst)
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

// copyDirContents copies all contents of src into dst, creating dst if it
// does not exist. Mirrors `mkdir -p "$DST" && cp -r "$SRC"/* "$DST/"`.
// Returns a non-nil error if src does not exist (the install.command uses an
// `if [[ -d "$SRC" ]]` guard; we treat a missing source as an error so
// callers know the asset was not bundled).
// replaceDirContents deletes dst then copies src into place, so the
// destination is an exact mirror of the source. Used for engine-shipped
// assets (the SDK) where merge-copy semantics would leave orphaned
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

// stampBuildIdentity writes build-identity.json into the SDK directory tree
// at ion-sdk/build-identity.json. The SDK runtime reads this file at init
// time and reports it in the init response so the engine Host can detect
// version mismatches between the engine binary and the installed SDK.
func stampBuildIdentity(sdkDir string) error {
	identity := struct {
		BuildIdentity string `json:"buildIdentity"`
	}{BuildIdentity: version}
	data, err := json.Marshal(identity)
	if err != nil {
		return fmt.Errorf("marshal build identity: %w", err)
	}
	dst := filepath.Join(sdkDir, "ion-sdk", "build-identity.json")
	return os.WriteFile(dst, data, 0o644)
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
