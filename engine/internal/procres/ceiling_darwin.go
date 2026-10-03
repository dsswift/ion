package procres

import "golang.org/x/sys/unix"

// platformDescriptorCeiling returns the kernel's per-process descriptor cap,
// which applies even when RLIMIT_NOFILE is unlimited.
func platformDescriptorCeiling() int64 {
	v, err := unix.SysctlUint32("kern.maxfilesperproc")
	if err != nil {
		return Unknown
	}
	return int64(v)
}
