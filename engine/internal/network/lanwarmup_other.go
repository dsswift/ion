//go:build !darwin || !cgo

package network

import "errors"

// Local Network privacy is a macOS mechanism; there is nothing to warm on
// other platforms, and a darwin build compiled without cgo cannot reach
// Network.framework (WarmLocalNetwork logs the skip).
var lanWarmupSupported = false // var (not const) so tests can exercise the retry loop on any platform

func lanWarmProbe(gateway string, timeoutMs int) int {
	return lanWarmFailed
}

func defaultGateway() (string, error) {
	return "", errors.New("lan warmup not supported on this platform")
}
