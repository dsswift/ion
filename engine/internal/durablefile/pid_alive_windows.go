//go:build windows

package durablefile

import "syscall"

const processQueryLimitedInformation = 0x1000

// pidAlive returns true if Windows can open a handle to the process.
func pidAlive(pid int) bool {
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(handle) //nolint:errcheck // best-effort handle cleanup
	return true
}
