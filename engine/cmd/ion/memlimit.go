package main

import (
	"os"
	"runtime/debug"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Memory-limit resolution constants. These are engine-owned defaults; the
// consumer-facing opinion seams are the GOMEMLIMIT env var and
// EngineConfig.MemoryLimitMB (see resolveMemoryLimit precedence).
const (
	// defaultMemLimitFraction is the fraction of host physical RAM used as the
	// engine's soft heap ceiling when neither GOMEMLIMIT nor MemoryLimitMB is set.
	// 0.70 leaves headroom for the OS, other processes, and non-heap engine memory
	// (goroutine stacks, mmap'd files, subprocess extensions) so the daemon stays
	// well below the level where the OS memory-pressure killer fires.
	defaultMemLimitFraction = 0.70

	// fallbackMemLimitBytes is the fixed soft ceiling used when host physical RAM
	// cannot be determined (physicalMemoryBytes() == 0, e.g. Windows or a sysctl
	// failure). 4 GiB is conservative: large enough not to throttle a normal
	// multi-session workload, small enough to still bound a runaway.
	fallbackMemLimitBytes int64 = 4 * 1024 * 1024 * 1024

	// bytesPerMiB converts the MemoryLimitMB config field to bytes.
	bytesPerMiB int64 = 1024 * 1024
)

// memLimitSource describes where the resolved limit came from, for logging and
// for the "don't override the operator's env" guard in applyMemoryLimit.
type memLimitSource string

const (
	memSourceEnv      memLimitSource = "env"      // GOMEMLIMIT was set; runtime owns it.
	memSourceConfig   memLimitSource = "config"   // EngineConfig.MemoryLimitMB.
	memSourceHostRAM  memLimitSource = "host-ram" // derived fraction of physical RAM.
	memSourceFallback memLimitSource = "fallback" // fixed default; host RAM unknown.
)

// resolveMemoryLimit computes the soft heap ceiling (in bytes) and its source,
// following the documented precedence. It performs NO side effects — it does not
// touch the runtime — so it is fully unit-testable. applyMemoryLimit is the thin
// side-effecting wrapper.
//
// Precedence:
//  1. GOMEMLIMIT env var present ⇒ source=env, bytes=0 (runtime already owns it;
//     applyMemoryLimit must NOT call SetMemoryLimit and clobber the operator's choice).
//  2. cfg.MemoryLimitMB > 0 ⇒ source=config.
//  3. physicalMemoryBytes() > 0 ⇒ source=host-ram (fraction of physical RAM).
//  4. otherwise ⇒ source=fallback (fixed default).
func resolveMemoryLimit(cfg *types.EngineRuntimeConfig, envGoMemLimit string, physRAM uint64) (int64, memLimitSource) {
	if envGoMemLimit != "" {
		return 0, memSourceEnv
	}
	if cfg != nil && cfg.MemoryLimitMB > 0 {
		return int64(cfg.MemoryLimitMB) * bytesPerMiB, memSourceConfig
	}
	if physRAM > 0 {
		limit := int64(float64(physRAM) * defaultMemLimitFraction)
		if limit > 0 {
			return limit, memSourceHostRAM
		}
	}
	return fallbackMemLimitBytes, memSourceFallback
}

// applyMemoryLimit resolves the engine's soft heap ceiling and, unless the operator
// set GOMEMLIMIT explicitly, applies it via runtime/debug.SetMemoryLimit. It logs
// the resolved value and source, and returns the effective limit in bytes for the
// memory monitor to report.
//
// When the source is env, we return the runtime's current effective limit
// (debug.SetMemoryLimit(-1) reads without setting) so the monitor reports the real
// ceiling the operator chose, not a zero.
func applyMemoryLimit(cfg *types.EngineRuntimeConfig) int64 {
	envVal := os.Getenv("GOMEMLIMIT")
	bytes, source := resolveMemoryLimit(cfg, envVal, physicalMemoryBytes())

	if source == memSourceEnv {
		// The Go runtime already parsed GOMEMLIMIT at startup. Read the effective
		// value back without changing it, so the monitor and log reflect reality.
		effective := debug.SetMemoryLimit(-1)
		utils.LogWithFields(utils.LevelInfo, "memlimit", "applymemorylimit: mb (, runtime owns it; not overriding)", map[string]any{"effective_bytes_per_mi_b": effective/bytesPerMiB, "source": source, "env_val": envVal})
		return effective
	}

	debug.SetMemoryLimit(bytes)
	utils.LogWithFields(utils.LevelInfo, "memlimit", "applymemorylimit: mb (soft gc ceiling; not a hard cap)", map[string]any{"bytes_bytes_per_mi_b": bytes/bytesPerMiB, "source": source})
	return bytes
}
