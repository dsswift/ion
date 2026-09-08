package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
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
// Action: copy engine-shipped SDK assets into ~/.ion/extensions with replace
// semantics. The TypeScript SDK is used by TypeScript extensions. The Go SDK
// is used by compiled Go extensions and must move with the engine so extension
// builds use the public surface from the same engine release.
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

	// Install both SDKs with replace semantics. Each installed copy is a derived
	// build asset, never a source tree; a merge could preserve stale API files.
	assets := []struct {
		name string
		src  string
		dst  string
	}{
		{
			name: "TypeScript SDK",
			src:  filepath.Join(assetRoot, "extensions", "sdk"),
			dst:  filepath.Join(ionHome, "extensions", "sdk"),
		},
		{
			name: "Go SDK",
			src:  filepath.Join(assetRoot, "extensions", "sdk-go"),
			dst:  filepath.Join(ionHome, "extensions", "sdk-go"),
		},
	}
	for _, asset := range assets {
		if err := replaceDirContents(asset.src, asset.dst); err != nil {
			fmt.Fprintf(os.Stderr, "install-assets: install %s: %v\n", asset.name, err)
			os.Exit(1)
		}
	}

	// Stamp the engine's build identity into the installed TypeScript SDK so the
	// subprocess can report it during the init handshake. The Go SDK links its
	// identity into compiled extension binaries at build time.
	if err := stampBuildIdentity(filepath.Join(ionHome, "extensions", "sdk")); err != nil {
		fmt.Fprintf(os.Stderr, "install-assets: stamp build identity: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("==> Installed extension SDKs to %s\n", filepath.Join(ionHome, "extensions"))
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
// replaceDirContents makes dst an exact mirror of src, so upgrades never
// leave orphaned files behind. On Windows a stale file held open by a live
// extension host cannot simply be RemoveAll'd (the OS refuses to delete an
// open file), so the existing tree is moved aside first — a rename succeeds
// even while a file inside it is open — and the aside copy is removed
// best-effort afterward. A held-open file leaves an "<dst>.old-*" directory
// that the next call to this function reaps.
func replaceDirContents(src, dst string) error {
	if _, err := os.Stat(src); err != nil {
		return fmt.Errorf("source %q not found: %w", src, err)
	}

	aside := ""
	if _, err := os.Stat(dst); err == nil {
		aside = fmt.Sprintf("%s.old-%d", dst, time.Now().UnixNano())
		if err := os.Rename(dst, aside); err != nil {
			return fmt.Errorf("move aside %q: %w", dst, err)
		}
		utils.LogWithFields(utils.LevelInfo, "main", "install-assets: moved existing tree aside", map[string]any{"dst": dst, "aside": aside})
	}

	if err := copyDirContents(src, dst); err != nil {
		return err
	}

	if aside != "" {
		if err := os.RemoveAll(aside); err != nil {
			utils.LogWithFields(utils.LevelWarn, "main", "install-assets: aside tree not removed (held open); next run retries", map[string]any{"aside": aside, "error": utils.ErrStr(err)})
		} else {
			utils.Log("main", "install-assets: aside tree removed")
		}
	}
	reapAsideTrees(filepath.Dir(dst), filepath.Base(dst)+".old-")
	return nil
}

// reapAsideTrees best-effort removes any leftover "<prefix>*" directories in
// dir from a previous replaceDirContents call whose aside removal failed
// (the file that was held open at the time is very likely free by now).
func reapAsideTrees(dir, prefix string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if err := os.RemoveAll(p); err != nil {
			utils.LogWithFields(utils.LevelDebug, "main", "install-assets: leftover aside tree still held open", map[string]any{"path": p, "error": utils.ErrStr(err)})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "main", "install-assets: reaped leftover aside tree", map[string]any{"path": p})
	}
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
