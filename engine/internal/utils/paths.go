package utils

import "os"

// UserHomeDir resolves the user's home directory, honoring $HOME on every
// platform (including Windows) before falling back to os.UserHomeDir's
// native resolution (%USERPROFILE% there).
//
// Go's os.UserHomeDir ignores HOME entirely on Windows -- it reads only
// %USERPROFILE%. That is invisible on macOS and Linux, where HOME already is
// the native mechanism, but on Windows it silently defeats every test's
// t.Setenv("HOME", t.TempDir()) isolation: the test believes it redirected
// the engine into a throwaway directory, while every call site that resolves
// home via the stdlib directly keeps reading the CI runner's real profile.
// Route every home-directory resolution through this function instead of
// os.UserHomeDir so that isolation actually isolates on every platform the
// engine ships for.
func UserHomeDir() (string, error) {
	if home := os.Getenv("HOME"); home != "" {
		return home, nil
	}
	return os.UserHomeDir()
}

// ExpandHomePath expands a leading "~" in a filesystem path to the user's home
// directory. A bare "~" becomes the home dir; "~/foo" becomes "<home>/foo".
// Any other input (absolute, relative, empty, or a "~" that is not the first
// character) is returned unchanged. When the home directory cannot be
// resolved, the original path is returned so callers degrade to the literal
// value rather than to an empty string.
//
// Go's os package performs NO shell-style tilde expansion: os.OpenFile("~/x")
// attempts to create a file under a directory literally named "~", which fails
// silently for any config-supplied path. Every config field that accepts a
// filesystem path from a human-edited file (engine.json telemetry filePath,
// logging logDir, ...) must pass through this helper before the value reaches
// the filesystem. This is the single home-path expansion helper for the
// engine; config.ExpandTilde delegates here.
func ExpandHomePath(path string) string {
	if len(path) == 0 || path[0] != '~' {
		return path
	}
	home, err := UserHomeDir()
	if err != nil {
		return path
	}
	return home + path[1:]
}
