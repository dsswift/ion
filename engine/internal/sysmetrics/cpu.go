package sysmetrics

import "github.com/shirou/gopsutil/v4/cpu"

// cpuBusyIdle splits one aggregate CPU times reading into busy and total
// seconds. Idle and iowait count as idle; steal counts as busy, because a
// guest whose time is stolen by the hypervisor is not free to run work.
func cpuBusyIdle(t cpu.TimesStat) (busy, total float64) {
	idle := t.Idle + t.Iowait
	busy = t.User + t.Nice + t.System + t.Irq + t.Softirq + t.Steal
	return busy, busy + idle
}

// hostCPUUtilization returns the share of CPU in use between two aggregate
// readings, 0..1. It returns ok=false when there is nothing to compare: no
// time elapsed, or the counters went backwards (a reset or a wrapped counter),
// which would otherwise produce a nonsense or negative value.
func hostCPUUtilization(prev, cur cpu.TimesStat) (float64, bool) {
	prevBusy, prevTotal := cpuBusyIdle(prev)
	curBusy, curTotal := cpuBusyIdle(cur)
	dTotal := curTotal - prevTotal
	dBusy := curBusy - prevBusy
	if dTotal <= 0 || dBusy < 0 {
		return 0, false
	}
	u := dBusy / dTotal
	if u > 1 {
		u = 1
	}
	return u, true
}

// processCPUPercent returns CPU use between two readings of one process's
// total CPU time, where 100 means one full core. ok=false when no time
// elapsed or the CPU time went backwards.
func processCPUPercent(prevCPUMs, curCPUMs, prevAtMs, curAtMs int64) (float64, bool) {
	elapsed := curAtMs - prevAtMs
	used := curCPUMs - prevCPUMs
	if elapsed <= 0 || used < 0 {
		return 0, false
	}
	return float64(used) / float64(elapsed) * 100, true
}
