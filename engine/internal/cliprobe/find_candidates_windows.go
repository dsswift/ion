//go:build windows

package cliprobe

import "path/filepath"

// installCandidates returns the fixed non-PATH locations to check for name
// on Windows before falling back to $PATH (LookPath, which is PATHEXT-aware
// on this platform). There is no login shell to probe on Windows, so this is
// the full non-PATH search list.
func installCandidates(name string, env func(string) string, home string) []string {
	var candidates []string
	if appData := env("APPDATA"); appData != "" {
		candidates = append(candidates,
			filepath.Join(appData, "npm", name+".cmd"),
			filepath.Join(appData, "npm", name+".exe"),
		)
	}
	if userProfile := env("USERPROFILE"); userProfile != "" {
		candidates = append(candidates, filepath.Join(userProfile, ".local", "bin", name+".exe"))
	}
	if localAppData := env("LOCALAPPDATA"); localAppData != "" {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", name, name+".exe"))
	}
	if programFiles := env("ProgramFiles"); programFiles != "" {
		candidates = append(candidates, filepath.Join(programFiles, name, name+".exe"))
	}
	return candidates
}

// searchDescription names, in prose, everywhere Find looked. Used only in
// the not-found error so the message accurately reflects this platform's
// search order.
func searchDescription() string {
	return `%APPDATA%\npm, %USERPROFILE%\.local\bin, %LOCALAPPDATA%\Programs, %ProgramFiles%, and PATH (with PATHEXT)`
}

// toolchainCandidates returns the daemon-mode fallback locations for a build
// toolchain binary (node, esbuild) on windows, checked after $PATH.
func toolchainCandidates(name string, env func(string) string) []string {
	var candidates []string
	if programFiles := env("ProgramFiles"); programFiles != "" {
		candidates = append(candidates, filepath.Join(programFiles, "nodejs", name+".exe"))
	}
	if appData := env("APPDATA"); appData != "" {
		candidates = append(candidates, filepath.Join(appData, "npm", name+".cmd"))
	}
	if localAppData := env("LOCALAPPDATA"); localAppData != "" {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", "nodejs", name+".exe"))
	}
	return candidates
}

// toolchainSearchDescription names, in prose, everywhere FindToolchain
// looked on this platform.
func toolchainSearchDescription() string {
	return `PATH (with PATHEXT), %ProgramFiles%\nodejs, %APPDATA%\npm, and %LOCALAPPDATA%\Programs\nodejs`
}
