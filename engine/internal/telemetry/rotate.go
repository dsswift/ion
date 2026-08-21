package telemetry

import (
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Size-based rotation for the telemetry "file" target.
//
// The file sink appended without bound: flushToFile opened O_APPEND and never
// looked at the size, and the schema checkpoint that once archived the file was
// replaced by a monotonic sidecar (schema.go: "no rotation"). On a working
// machine the result is ~11 MB/day forever — 373 MB observed after a month.
// Downstream shipping does not bound it either: the egress tailer only advances
// a byte offset, so a shipped file still grows.
//
// The mechanism mirrors utils.rotateLocked (the engine-log rotator): rename the
// live file to ".1", shifting older generations down, and let the next append
// create a fresh file. Rotating by rename is what makes this safe for a
// concurrent reader — the desktop egress tailer detects the inode change at the
// path and follows the new file (log-egress-tailer.ts), so no line is shipped
// twice and none is lost.
//
// The size cap and the retained-archive count are operator opinions
// (TelemetryConfig.MaxSizeMB / MaxFiles / DisableRotation); the rotation itself
// is the engine's mechanism.

const (
	// defaultMaxSizeMB is the compiled default cap on the live telemetry file.
	// Matches the engine log's default so an operator learns one number.
	defaultMaxSizeMB = 20
	// defaultMaxFiles is the compiled default number of retained archives.
	defaultMaxFiles = 3
)

// rotationPolicy is the resolved, already-defaulted rotation decision. A zero
// maxBytes means rotation is disabled.
type rotationPolicy struct {
	maxBytes int64
	maxFiles int
}

// resolveRotation turns operator config into a policy, applying the compiled
// defaults. Reported by the caller at startup so the live policy is visible in
// the log without reading engine.json.
func resolveRotation(maxSizeMB, maxFiles int, disabled bool) rotationPolicy {
	if disabled {
		return rotationPolicy{}
	}
	if maxSizeMB == 0 {
		maxSizeMB = defaultMaxSizeMB
	}
	if maxSizeMB < 0 {
		// A negative cap is not a smaller cap; treat it as the operator asking
		// for no bound and say so, rather than silently rotating every flush.
		utils.LogWithFields(utils.LevelWarn, "telemetry", "negative rotation size treated as disabled", map[string]any{
			"max_size_mb": maxSizeMB,
		})
		return rotationPolicy{}
	}
	switch {
	case maxFiles == 0:
		maxFiles = defaultMaxFiles
	case maxFiles < 0:
		// Explicitly no archives: the live file is discarded at the cap, which
		// bounds disk to one file's worth.
		maxFiles = 0
	}
	return rotationPolicy{maxBytes: int64(maxSizeMB) * 1024 * 1024, maxFiles: maxFiles}
}

// rotateIfOversize rotates path when it has reached the policy's cap. It is
// called before an append, so the cap bounds the file at (maxBytes + one
// flush), not exactly maxBytes.
//
// Every outcome logs: rotation performed, rotation skipped because the file is
// under the cap (debug — one line per flush), and every filesystem failure. A
// rotation failure is not fatal: the append proceeds against whatever file is
// at the path, because losing telemetry lines is worse than an oversized file.
func rotateIfOversize(path string, p rotationPolicy) {
	if p.maxBytes <= 0 {
		return
	}
	fi, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, "telemetry", "rotation stat failed", map[string]any{
				"path": path, "error": err.Error(),
			})
		}
		return
	}
	if fi.Size() < p.maxBytes {
		utils.LogWithFields(utils.LevelDebug, "telemetry", "rotation not needed", map[string]any{
			"path": path, "size": fi.Size(), "max_bytes": p.maxBytes,
		})
		return
	}

	// No archives retained: discard the live file outright.
	if p.maxFiles == 0 {
		if err := os.Remove(path); err != nil {
			utils.LogWithFields(utils.LevelWarn, "telemetry", "rotation discard failed", map[string]any{
				"path": path, "size": fi.Size(), "error": err.Error(),
			})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "telemetry", "rotated telemetry file", map[string]any{
			"path": path, "size": fi.Size(), "max_bytes": p.maxBytes, "max_files": 0, "archived": false,
		})
		return
	}

	// Shift generations down: .(n-1) → .n, dropping whatever was in .n.
	for i := p.maxFiles - 1; i >= 1; i-- {
		older := fmt.Sprintf("%s.%d", path, i+1)
		newer := fmt.Sprintf("%s.%d", path, i)
		if _, err := os.Stat(newer); err != nil {
			continue
		}
		if err := os.Rename(newer, older); err != nil {
			utils.LogWithFields(utils.LevelWarn, "telemetry", "rotation generation shift failed", map[string]any{
				"from": newer, "to": older, "error": err.Error(),
			})
		}
	}

	archive := path + ".1"
	if err := os.Rename(path, archive); err != nil {
		utils.LogWithFields(utils.LevelWarn, "telemetry", "rotation rename failed", map[string]any{
			"path": path, "to": archive, "size": fi.Size(), "error": err.Error(),
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "telemetry", "rotated telemetry file", map[string]any{
		"path": path, "to": archive, "size": fi.Size(),
		"max_bytes": p.maxBytes, "max_files": p.maxFiles, "archived": true,
	})
}
