package telemetry

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// SystemMetrics is a periodic System Metrics sample: host load and the
// engine's process tree, as numbers plus process role and name only.
// Recorded every systemMetrics.telemetryIntervalMs while a collector is
// enabled (see NewSystemMetricsRecorder).
const SystemMetrics = "system.metrics"

// SystemMetricsPayload flattens a System Metrics sample into a telemetry
// event payload: host figures, runtime figures, and one row per process with
// its role and name. It holds numbers and labels only, never content, so it
// is the same at every privacy level.
func SystemMetricsPayload(sample types.SystemMetricsSample) map[string]any {
	h, r := sample.Host, sample.Runtime
	host := map[string]any{
		"cpu_count":              h.CPUCount,
		"effective_cpu_count":    h.EffectiveCPUCount,
		"memory_total_bytes":     h.MemoryTotalBytes,
		"memory_available_bytes": h.MemoryAvailableBytes,
		"memory_limit_bytes":     h.MemoryLimitBytes,
		"container_limited":      h.ContainerLimited,
		"disk_total_bytes":       h.DiskTotalBytes,
		"disk_free_bytes":        h.DiskFreeBytes,
	}
	if h.CPUUtilization != nil {
		host["cpu_utilization"] = *h.CPUUtilization
	}
	if h.Load1 != nil {
		host["load1"] = *h.Load1
	}
	procs := make([]map[string]any, 0, len(sample.Processes))
	for _, p := range sample.Processes {
		row := map[string]any{"role": p.Role, "name": p.Name, "rss_bytes": p.RSSBytes, "cpu_time_ms": p.CPUTimeMs}
		if p.CPUPercent != nil {
			row["cpu_percent"] = *p.CPUPercent
		}
		// The owning session, when the spawn site registered one, so a
		// row's CPU and memory attribute to a conversation.
		if p.SessionID != "" {
			row["session_id"] = p.SessionID
		}
		procs = append(procs, row)
	}
	return map[string]any{
		"sampled_at":  sample.SampledAt,
		"interval_ms": sample.IntervalMs,
		"host":        host,
		"processes":   procs,
		"runtime": map[string]any{
			"heap_bytes":      r.HeapBytes,
			"sys_bytes":       r.SysBytes,
			"mem_limit_bytes": r.MemLimitBytes,
			"goroutines":      r.Goroutines,
			"num_gc":          r.NumGC,
			"sessions":        r.Sessions,
			// Interval figures from runtime/metrics; see
			// types.SystemMetricsRuntime for each one's meaning.
			"gc_pause_p99_ms":        r.GCPauseP99Ms,
			"alloc_rate_bytes_per_s": r.AllocRateBytesPerS,
			"sched_latency_p99_ms":   r.SchedLatencyP99Ms,
		},
	}
}

// NewSystemMetricsRecorder returns a function that records a system.metrics
// event on c at most once per interval, however often it is handed samples.
// The sampler speeds up while a client watches; the telemetry stream keeps
// its own steady cadence regardless.
func NewSystemMetricsRecorder(c *Collector, interval time.Duration) func(types.SystemMetricsSample) {
	var mu sync.Mutex
	var last int64
	return func(sample types.SystemMetricsSample) {
		if c == nil {
			return
		}
		mu.Lock()
		due := last == 0 || sample.SampledAt-last >= interval.Milliseconds()
		if due {
			last = sample.SampledAt
		}
		mu.Unlock()
		if due {
			c.Event(SystemMetrics, SystemMetricsPayload(sample), nil)
		}
	}
}
