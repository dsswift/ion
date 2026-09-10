//go:build windows

package extension

import "os"

// nativeEntryName is the conventional entry-point filename for extensions
// compiled to a native binary on windows. It is probed after every script
// candidate: a directory shipping both a script and a compiled binary is a
// source tree, and the script is the authored entry point.
const nativeEntryName = "main.exe"

// nativeEntryLabelSuffix is appended to nativeEntryName in the not-found
// error's candidate list. Windows has no exec-bit concept, so there is no
// extra requirement to name.
const nativeEntryLabelSuffix = ""

// nativeEntryOK reports whether info describes a valid native entry on this
// platform. Windows has no exec-bit concept: existing as a regular file
// (already checked by the caller) is sufficient.
func nativeEntryOK(info os.FileInfo) bool {
	return true
}
