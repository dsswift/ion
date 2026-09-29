//go:build darwin

package sysmetrics

import "golang.org/x/sys/unix"

// parentTable returns pid → parent pid for every process on the host, from a
// single kern.proc.all sysctl. gopsutil's own Children() re-lists every
// process and reads each one's parent with a further sysctl, per level of the
// tree; one table per sample avoids that cost. Only the engine's own
// descendants are kept from it (see walkTree).
func parentTable() (map[int32]int32, error) {
	kprocs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	out := make(map[int32]int32, len(kprocs))
	for i := range kprocs {
		out[kprocs[i].Proc.P_pid] = kprocs[i].Eproc.Ppid
	}
	return out, nil
}
