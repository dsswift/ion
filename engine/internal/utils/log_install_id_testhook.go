package utils

import "sync"

// ResetInstallIDForTest resets the package-level install_id singleton so tests
// can exercise minting in isolation (with a fresh HOME). Test-only; production
// code never resets the once.
func ResetInstallIDForTest() {
	installIDOnce = sync.Once{}
	installID = ""
}
