package utils

import "os"

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
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return home + path[1:]
}
