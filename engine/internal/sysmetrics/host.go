package sysmetrics

import (
	"context"
	"runtime"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// hostFigures is the working set applyCgroupLimits narrows before it becomes
// a types.SystemMetricsHost.
type hostFigures struct {
	cpuCount         int
	effectiveCPU     float64
	memoryTotal      uint64
	memoryAvailable  uint64
	memoryLimit      uint64
	containerLimited bool
}

// hostReader holds the previous aggregate CPU reading, so each sample can
// report utilization since the last one instead of since boot.
type hostReader struct {
	prevCPU *cpu.TimesStat
	// cgroup is swappable so tests can feed fixture limits.
	cgroup func() cgroupLimits
}

func newHostReader() *hostReader {
	return &hostReader{cgroup: hostCgroupLimits}
}

// PhysicalMemoryBytes returns the host's total physical memory, or 0 when it
// cannot be read. It is the one host-RAM reader the engine uses, including
// for its soft heap ceiling.
func PhysicalMemoryBytes() uint64 {
	vm, err := mem.VirtualMemory()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "physical memory read failed", map[string]any{"error": err.Error()})
		return 0
	}
	return vm.Total
}

// read takes one host sample. A counter that cannot be read leaves its field
// at zero (or nil) and is logged; it never fails the whole sample.
func (r *hostReader) read(ctx context.Context, diskPath string) types.SystemMetricsHost {
	h := types.SystemMetricsHost{DiskPath: diskPath}
	fig := hostFigures{cpuCount: runtime.NumCPU()}
	fig.effectiveCPU = float64(fig.cpuCount)

	if times, err := cpu.TimesWithContext(ctx, false); err != nil || len(times) == 0 {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "host cpu read failed", map[string]any{"error": errString(err)})
	} else {
		cur := times[0]
		if r.prevCPU != nil {
			if u, ok := hostCPUUtilization(*r.prevCPU, cur); ok {
				h.CPUUtilization = &u
			}
		}
		r.prevCPU = &cur
	}

	if vm, err := mem.VirtualMemoryWithContext(ctx); err != nil {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "host memory read failed", map[string]any{"error": err.Error()})
	} else {
		fig.memoryTotal = vm.Total
		fig.memoryAvailable = vm.Available
	}

	applyCgroupLimits(&fig, r.cgroup())
	h.CPUCount = fig.cpuCount
	h.EffectiveCPUCount = fig.effectiveCPU
	h.MemoryTotalBytes = fig.memoryTotal
	h.MemoryAvailableBytes = fig.memoryAvailable
	h.MemoryLimitBytes = fig.memoryLimit
	h.ContainerLimited = fig.containerLimited

	// Windows has no load average; gopsutil emulates one there, which would
	// read as a real figure, so it is left nil instead.
	if runtime.GOOS != "windows" {
		if avg, err := load.AvgWithContext(ctx); err != nil {
			utils.LogWithFields(utils.LevelWarn, "sysmetrics", "host load read failed", map[string]any{"error": err.Error()})
		} else {
			l := avg.Load1
			h.Load1 = &l
		}
	}

	if diskPath != "" {
		if du, err := disk.UsageWithContext(ctx, diskPath); err != nil {
			utils.LogWithFields(utils.LevelWarn, "sysmetrics", "host disk read failed", map[string]any{"error": err.Error(), "path": diskPath})
		} else {
			h.DiskTotalBytes = du.Total
			h.DiskFreeBytes = du.Free
		}
	}
	return h
}

func errString(err error) string {
	if err == nil {
		return "no data"
	}
	return err.Error()
}
