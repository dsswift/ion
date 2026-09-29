//go:build !linux

package sysmetrics

// hostCgroupLimits reports no limits: cgroups exist only on Linux.
func hostCgroupLimits() cgroupLimits { return cgroupLimits{} }
