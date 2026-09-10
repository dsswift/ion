//go:build !windows

package main

import "github.com/dsswift/ion/engine/internal/utils"

// The host exists to solve a Windows-only problem (see the package comment).
// It still builds everywhere so `go build ./...` and `go vet ./...` cover it
// on the Linux CI runners, and refuses to run rather than silently
// pretending to supervise anything.

func usage() int {
	utils.Error("engine-host", "ion-engine-host takes the engine binary path followed by its arguments")
	return 2
}

func runHost(_ string, _ []string) int {
	utils.Error("engine-host", "ion-engine-host is a Windows-only launcher; run the engine directly on this platform")
	return 2
}
