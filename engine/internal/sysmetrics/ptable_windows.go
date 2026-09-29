//go:build windows

package sysmetrics

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// parentTable returns pid → parent pid for every process, from one toolhelp
// snapshot. Only the engine's own descendants are kept from it (see walkTree).
func parentTable() (map[int32]int32, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap) //nolint:errcheck // read-only snapshot handle
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	out := map[int32]int32{}
	if err := windows.Process32First(snap, &pe); err != nil {
		return nil, err
	}
	for {
		out[int32(pe.ProcessID)] = int32(pe.ParentProcessID)
		if err := windows.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return out, nil
}
