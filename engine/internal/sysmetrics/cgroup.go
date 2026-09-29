package sysmetrics

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cgroupLimits is what a cgroup v2 hierarchy says about the container the
// engine runs in. Zero values mean "no limit found".
type cgroupLimits struct {
	memoryMaxBytes     uint64
	memoryCurrentBytes uint64
	cpuQuota           float64 // CPUs, e.g. 1.5 for a 150000/100000 quota
}

// readCgroupLimits reads cgroup v2 limits from dir (the process's cgroup
// directory, normally /sys/fs/cgroup). Missing files mean no limit. The
// parsing is portable so it is tested on every OS; only Linux calls it on a
// real hierarchy.
func readCgroupLimits(dir string) cgroupLimits {
	var l cgroupLimits
	if v, ok := parseCgroupMax(readTrimmed(filepath.Join(dir, "memory.max"))); ok {
		l.memoryMaxBytes = v
	}
	if v, err := strconv.ParseUint(readTrimmed(filepath.Join(dir, "memory.current")), 10, 64); err == nil {
		l.memoryCurrentBytes = v
	}
	l.cpuQuota = parseCPUMax(readTrimmed(filepath.Join(dir, "cpu.max")))
	return l
}

func readTrimmed(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// parseCgroupMax parses a memory.max value: a byte count, or "max" for no
// limit. ok=false for "max", empty, or unparseable.
func parseCgroupMax(v string) (uint64, bool) {
	if v == "" || v == "max" {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil || n == 0 {
		return 0, false
	}
	return n, true
}

// parseCPUMax parses cpu.max ("<quota> <period>", quota "max" for none) into
// a number of CPUs. Returns 0 when there is no quota.
func parseCPUMax(v string) float64 {
	fields := strings.Fields(v)
	if len(fields) != 2 || fields[0] == "max" {
		return 0
	}
	quota, err1 := strconv.ParseFloat(fields[0], 64)
	period, err2 := strconv.ParseFloat(fields[1], 64)
	if err1 != nil || err2 != nil || quota <= 0 || period <= 0 {
		return 0
	}
	return quota / period
}

// applyCgroupLimits narrows host figures to a container's limits. A memory
// limit below physical memory replaces the available figure with the limit
// minus current use; a CPU quota below the CPU count becomes the effective
// CPU count. Limits above the host's own figures are ignored, because they
// do not narrow anything.
func applyCgroupLimits(h *hostFigures, l cgroupLimits) {
	if l.memoryMaxBytes > 0 && l.memoryMaxBytes < h.memoryTotal {
		h.memoryLimit = l.memoryMaxBytes
		avail := uint64(0)
		if l.memoryCurrentBytes < l.memoryMaxBytes {
			avail = l.memoryMaxBytes - l.memoryCurrentBytes
		}
		if avail < h.memoryAvailable {
			h.memoryAvailable = avail
		}
		h.containerLimited = true
	}
	if l.cpuQuota > 0 && l.cpuQuota < float64(h.cpuCount) {
		h.effectiveCPU = l.cpuQuota
		h.containerLimited = true
	}
}
