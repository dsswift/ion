package extension

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ResolvedExtensionPlan is the filesystem-only result of resolving an
// extension declaration. It intentionally contains no process state.
type ResolvedExtensionPlan struct {
	Path       string
	Directory  string
	Manifest   *Manifest
	Identifier string
}

// ResolveExtensionPath expands a configured extension path and resolves a
// directory to its conventional entry point. It does not spawn a process.
func ResolveExtensionPath(extensionPath string) (string, error) {
	if strings.HasPrefix(extensionPath, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve home for extension path: %w", err)
		}
		extensionPath = filepath.Join(home, extensionPath[2:])
	}
	absPath, err := filepath.Abs(extensionPath)
	if err != nil {
		return "", fmt.Errorf("resolve extension path: %w", err)
	}
	info, err := os.Stat(absPath)
	if err != nil {
		return "", fmt.Errorf("extension path not found: %w", err)
	}
	if !info.IsDir() {
		return absPath, nil
	}
	entry, err := ResolveExtensionEntry(absPath)
	if err != nil {
		return "", err
	}
	return entry, nil
}

// ResolveExtensionEntry maps an extension directory to its conventional entry
// point without loading it.
func ResolveExtensionEntry(extDir string) (string, error) {
	for _, name := range extensionEntryCandidates {
		candidate := filepath.Join(extDir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	native := filepath.Join(extDir, nativeExtensionEntry)
	if info, err := os.Stat(native); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		return native, nil
	}
	candidates := append(append([]string{}, extensionEntryCandidates...), nativeExtensionEntry+" (executable)")
	return "", fmt.Errorf("no extension entry point in %s (looked for %s)", extDir, strings.Join(candidates, ", "))
}

// PreflightExtensions resolves every configured extension and validates every
// manifest before the caller starts any extension process. It examines all
// paths so an operator receives every independent configuration error.
func PreflightExtensions(paths []string) ([]ResolvedExtensionPlan, error) {
	plans := make([]ResolvedExtensionPlan, 0, len(paths))
	errs := make([]error, 0)
	for _, configuredPath := range paths {
		entry, err := ResolveExtensionPath(configuredPath)
		if err != nil {
			errs = append(errs, fmt.Errorf("extension %q: %w", configuredPath, err))
			continue
		}
		dir := filepath.Dir(entry)
		manifest, err := LoadManifest(dir)
		if err != nil {
			errs = append(errs, fmt.Errorf("extension %q: %w", configuredPath, err))
			continue
		}
		identifier := filepath.Base(dir)
		if manifest != nil && manifest.Name != "" {
			identifier = manifest.Name
		}
		plans = append(plans, ResolvedExtensionPlan{
			Path: entry, Directory: dir, Manifest: manifest, Identifier: identifier,
		})
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return plans, nil
}
