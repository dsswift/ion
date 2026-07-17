package main

import (
	"runtime"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Memory-monitor constants. This is observability mechanism: it closes the
// logging blind spot the diagnosis identified — nothing previously recorded RSS /
// heap pressure approaching the danger zone before the OS killed the daemon.
const (
	// memMonitorInterval is how often the monitor samples and logs. 30s keeps the
	// log readable while still catching pressure well before an OS kill.
	memMonitorInterval = 30 * time.Second

	// memMonitorWarnFraction is the high-water mark (fraction of the soft limit)
	// past which the monitor escalates from INFO to ERROR so an approaching kill is
	// loud in the log. 0.85 gives lead time before GC pressure becomes severe.
	memMonitorWarnFraction = 0.85

	memMonitorBytesPerMiB uint64 = 1024 * 1024
)

// startMemoryMonitor launches a daemon-style goroutine that periodically logs the
// engine's heap footprint against its soft ceiling and the live session count.
// Modeled on the heartbeat goroutine in cmd_serve.go: no shutdown sync is needed
// because the process teardown paths (writeClean / writePanic) run independently.
//
// limitBytes is the effective soft ceiling from applyMemoryLimit (0 only if the
// runtime reports no limit at all, in which case the warn threshold is disabled).
// sessionCount is a closure so this file does not import internal/server (avoids a
// cmd→internal import cycle) — cmd_serve wires it from srv.SessionManager().
func startMemoryMonitor(limitBytes int64, sessionCount func() int) {
	go func() {
		t := time.NewTicker(memMonitorInterval)
		defer t.Stop()
		for range t.C {
			sampleAndLogMemory(limitBytes, sessionCount)
		}
	}()
	utils.LogWithFields(utils.LevelInfo, "memmonitor", "started: %b", map[string]any{"mem_monitor_interval": memMonitorInterval, "mem_monitor_warn_fraction_100": memMonitorWarnFraction*100, "limit_bytes_int64": limitBytes/int64(memMonitorBytesPerMiB)})
}

// sampleAndLogMemory reads a MemStats sample and logs it. Extracted from the
// goroutine so it is unit-testable without waiting on a ticker. Logs at ERROR when
// heap is at/above the warn threshold, INFO otherwise — both branches always log,
// per the "log both sides" logging policy.
func sampleAndLogMemory(limitBytes int64, sessionCount func() int) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	sessions := 0
	if sessionCount != nil {
		sessions = sessionCount()
	}

	heapMB := ms.HeapAlloc / memMonitorBytesPerMiB
	sysMB := ms.Sys / memMonitorBytesPerMiB
	limitMB := uint64(0)
	if limitBytes > 0 {
		limitMB = uint64(limitBytes) / memMonitorBytesPerMiB
	}

	if limitBytes > 0 && float64(ms.HeapAlloc) >= float64(limitBytes)*memMonitorWarnFraction {
		utils.LogWithFields(utils.LevelError, "memmonitor", "HIGH MEMORY", map[string]any{
			"heap_mb": heapMB, "sys_mb": sysMB, "limit_mb": limitMB,
			"sessions": sessions, "num_gc": ms.NumGC,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "memmonitor", "memory sample", map[string]any{
		"heap_mb": heapMB, "sys_mb": sysMB, "limit_mb": limitMB,
		"sessions": sessions, "num_gc": ms.NumGC,
	})
}
