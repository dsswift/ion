//go:build !windows

package extension

import "os"

// nativeEntryName is the conventional entry-point filename for extensions
// compiled to a native binary (Go, Rust, C, ...) on unix. It is probed after
// every script candidate: a directory shipping both a script and a compiled
// binary is a source tree, and the script is the authored entry point.
const nativeEntryName = "main"

// nativeEntryLabelSuffix is appended to nativeEntryName in the not-found
// error's candidate list, naming the extra requirement this platform checks.
const nativeEntryLabelSuffix = " (executable)"

// nativeEntryOK reports whether info describes a valid native entry on this
// platform: unix additionally requires the exec bit, since a non-executable
// "main" is data, not a binary.
func nativeEntryOK(info os.FileInfo) bool {
	return info.Mode()&0o111 != 0
}
