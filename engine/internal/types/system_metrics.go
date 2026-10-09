package types

// SystemMetricsSample is one complete System Metrics snapshot: how busy the
// host is, and what each process in the engine's own process tree is using.
//
// Snapshot semantics (a contract, not an implementation detail): every
// engine_system_metrics event and every get_system_metrics result carries a
// COMPLETE sample. Consumers replace their local copy with it. They never
// merge, and a process absent from Processes is a process that is no longer
// running.
//
// The sample never carries a command line, an argument, or an environment
// value. A process is identified by its role and a short name only.
type SystemMetricsSample struct {
	// SampledAt is the Unix time the sample was taken, in milliseconds.
	SampledAt int64 `json:"sampledAt"`
	// IntervalMs is the sampling interval in effect when this sample was taken.
	IntervalMs int64                  `json:"intervalMs"`
	Host       SystemMetricsHost      `json:"host"`
	Processes  []SystemMetricsProcess `json:"processes"`
	Runtime    SystemMetricsRuntime   `json:"runtime"`
}

// SystemMetricsHost describes the machine (or container) the engine runs on.
type SystemMetricsHost struct {
	// CPUUtilization is the share of all CPUs in use since the previous
	// sample, 0..1. Nil on the first sample, when there is nothing to
	// compare against, or when the counters could not be read.
	CPUUtilization *float64 `json:"cpuUtilization"`
	// CPUCount is the number of logical CPUs the host reports.
	CPUCount int `json:"cpuCount"`
	// EffectiveCPUCount is CPUCount, or the container's CPU quota when a
	// cgroup limits it (fractional: a 1.5-CPU quota reports 1.5).
	EffectiveCPUCount float64 `json:"effectiveCpuCount"`
	// MemoryTotalBytes is the host's physical memory.
	MemoryTotalBytes uint64 `json:"memoryTotalBytes"`
	// MemoryAvailableBytes is memory available to new work without
	// swapping. Inside a memory-limited container it is the limit minus
	// the container's current use.
	MemoryAvailableBytes uint64 `json:"memoryAvailableBytes"`
	// MemoryLimitBytes is the container's memory limit, or 0 when none
	// applies.
	MemoryLimitBytes uint64 `json:"memoryLimitBytes"`
	// ContainerLimited is true when a cgroup limit narrowed CPU or memory.
	ContainerLimited bool `json:"containerLimited"`
	// Load1 is the one-minute load average. Nil where the OS has none
	// (Windows).
	Load1 *float64 `json:"load1"`
	// DiskPath is the directory whose volume the disk fields describe.
	DiskPath       string `json:"diskPath"`
	DiskTotalBytes uint64 `json:"diskTotalBytes"`
	DiskFreeBytes  uint64 `json:"diskFreeBytes"`
}

// System Metrics process roles. The set is small and fixed on purpose: it is
// the only label OpenTelemetry metrics carry, and each extra value multiplies
// the number of series a metrics store keeps.
const (
	SystemMetricsRoleEngine    = "engine"
	SystemMetricsRoleExtension = "extension"
	SystemMetricsRoleMcp       = "mcp"
	SystemMetricsRoleBackend   = "backend"
	SystemMetricsRoleTool      = "tool"
)

// SystemMetricsProcess is one process in the engine's own process tree.
type SystemMetricsProcess struct {
	Pid int32 `json:"pid"`
	// StartTimeMs is the process start time (Unix ms). Together with Pid it
	// identifies the process, so a reused pid is never mistaken for it.
	StartTimeMs int64 `json:"startTimeMs"`
	// Role is one of the SystemMetricsRole* values.
	Role string `json:"role"`
	// Name is the extension name, the MCP server name, or the executable's
	// base name. Never a command line.
	Name string `json:"name"`
	// CPUPercent is CPU use since the previous sample, where 100 is one full
	// core. Nil on a process's first sample.
	CPUPercent *float64 `json:"cpuPercent"`
	// CPUTimeMs is the process's total CPU time (user + system).
	CPUTimeMs int64 `json:"cpuTimeMs"`
	// RSSBytes is the resident memory of the process.
	RSSBytes uint64 `json:"rssBytes"`
	// SessionID is the engine session key the process serves, when the
	// spawn site that started it knew one (an extension host, an MCP server,
	// or a delegated-CLI backend started for a session). Empty for the
	// engine itself and for a process no session owns, so resource use can
	// be attributed to a conversation without inventing an owner.
	SessionID string `json:"sessionId,omitempty"`
}

// SystemMetricsRuntime is the engine's own Go runtime.
type SystemMetricsRuntime struct {
	HeapBytes uint64 `json:"heapBytes"`
	SysBytes  uint64 `json:"sysBytes"`
	// MemLimitBytes is the soft heap ceiling in effect (GOMEMLIMIT or the
	// engine's derived limit).
	MemLimitBytes int64  `json:"memLimitBytes"`
	Goroutines    int    `json:"goroutines"`
	NumGC         uint32 `json:"numGC"`
	Sessions      int    `json:"sessions"`
	// GCPauseP99Ms is the p99 of the Go runtime's stop-the-world pauses
	// since the previous sample, in milliseconds (runtime/metrics
	// /gc/pauses:seconds). 0 when no pause happened in the interval.
	GCPauseP99Ms float64 `json:"gcPauseP99Ms"`
	// AllocRateBytesPerS is heap bytes allocated per second since the
	// previous sample (/gc/heap/allocs:bytes). 0 on the first sample.
	AllocRateBytesPerS float64 `json:"allocRateBytesPerS"`
	// SchedLatencyP99Ms is the p99 of goroutine scheduling latency since the
	// previous sample, in milliseconds (/sched/latencies:seconds): how long
	// runnable goroutines waited for a thread. 0 when nothing waited.
	SchedLatencyP99Ms float64 `json:"schedLatencyP99Ms"`
}

// SystemMetricsConfig configures the System Metrics sampler.
type SystemMetricsConfig struct {
	// Enabled turns sampling on. Nil means the default, which is on.
	Enabled *bool `json:"enabled,omitempty"`
	// BackgroundIntervalMs is the sampling interval while no connection is
	// watching. Default 30000.
	BackgroundIntervalMs int64 `json:"backgroundIntervalMs,omitempty"`
	// MinIntervalMs is the fastest interval a watcher may ask for.
	// Default 250.
	MinIntervalMs int64 `json:"minIntervalMs,omitempty"`
	// DiskPath is the directory whose volume the disk fields report.
	// Default ~/.ion.
	DiskPath string `json:"diskPath,omitempty"`
	// TelemetryIntervalMs is how often a system.metrics telemetry event is
	// recorded when a telemetry collector is enabled. Default 60000.
	TelemetryIntervalMs int64 `json:"telemetryIntervalMs,omitempty"`
}

// IsEnabled reports whether System Metrics sampling is on. Nil config and a
// nil Enabled both mean on.
func (c *SystemMetricsConfig) IsEnabled() bool {
	if c == nil || c.Enabled == nil {
		return true
	}
	return *c.Enabled
}
