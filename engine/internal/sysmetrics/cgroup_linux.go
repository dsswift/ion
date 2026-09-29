//go:build linux

package sysmetrics

import (
	"os"
	"path/filepath"
	"strings"
)

// cgroupRoot is where the cgroup v2 unified hierarchy is mounted.
const cgroupRoot = "/sys/fs/cgroup"

// hostCgroupLimits reads the limits of the cgroup this process belongs to.
// /proc/self/cgroup names it ("0::/<path>" on v2); inside most containers the
// path is "/" and the limits sit at the mount root.
func hostCgroupLimits() cgroupLimits {
	dir := cgroupRoot
	if b, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if rel, ok := strings.CutPrefix(line, "0::"); ok {
				if candidate := filepath.Join(cgroupRoot, rel); candidate != cgroupRoot {
					if _, err := os.Stat(filepath.Join(candidate, "memory.max")); err == nil {
						dir = candidate
					}
				}
				break
			}
		}
	}
	return readCgroupLimits(dir)
}
