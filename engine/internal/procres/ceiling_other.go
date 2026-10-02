//go:build !windows && !darwin

package procres

// platformDescriptorCeiling reports no ceiling beyond RLIMIT_NOFILE.
func platformDescriptorCeiling() int64 { return Unknown }
