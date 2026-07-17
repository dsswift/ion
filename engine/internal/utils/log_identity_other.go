//go:build !darwin && !linux

package utils

func loadPlatformMachineIdentity() platformIdentity {
	return platformIdentity{}
}
