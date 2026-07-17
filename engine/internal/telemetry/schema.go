package telemetry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TelemetrySchemaVersion is the current telemetry file schema version.
// v1 = everything before the cost-field rename / unified log contract batch.
// v2 = unified snake_case payloads, schema/component/install_id top-level fields.
// v3 = additive attribution fields: per-event unique ID (event_id, R22) and
//      user identity carrier (user, R20 wired to auth context seam).
const TelemetrySchemaVersion = 3

// sidecarPath returns the path for the telemetry schema sidecar file.
// Lives alongside the telemetry file in the same directory.
func sidecarPath(telemetryFilePath string) string {
	dir := filepath.Dir(telemetryFilePath)
	return filepath.Join(dir, "telemetry.schema.json")
}

// schemaSidecar is the content of ~/.ion/telemetry.schema.json.
//
// The sidecar is a MONOTONIC observability record: HighestSchemaSeen is only
// ever raised, never lowered. A downgraded writer (older binary) appends
// lower-schema lines but does not lower the sidecar. This makes the file a
// high-water mark visible to dashboards and operators.
//
// Migration note: old sidecars written before this design used the key
// "schemaVersion" (no highest-seen semantics). readSidecar falls back to that
// key when HighestSchemaSeen is absent so operator/Chris machines migrate on
// the next startup without any manual action.
type schemaSidecar struct {
	HighestSchemaSeen int    `json:"highestSchemaSeen"`
	StampedAt         int64  `json:"stampedAt"`
	EngineVersion     string `json:"engineVersion"`
}

// readSidecar loads the sidecar from disk. Returns (sidecar, ok).
// ok is false when the file is absent or unreadable (treat as missing).
// Legacy sidecars that carry "schemaVersion" (old rotate-on-mismatch design)
// are transparently migrated: the "schemaVersion" value is read as
// HighestSchemaSeen when the new key is absent.
func readSidecar(path string) (schemaSidecar, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return schemaSidecar{}, false
	}
	// Try new shape first.
	var s schemaSidecar
	if err := json.Unmarshal(data, &s); err != nil {
		return schemaSidecar{}, false
	}
	// If HighestSchemaSeen is zero but the old "schemaVersion" key is present,
	// use it as the fallback (one-time migration from the rotate-on-mismatch era).
	if s.HighestSchemaSeen == 0 {
		var legacy struct {
			SchemaVersion int `json:"schemaVersion"`
		}
		if json.Unmarshal(data, &legacy) == nil && legacy.SchemaVersion > 0 {
			s.HighestSchemaSeen = legacy.SchemaVersion
		}
	}
	return s, true
}

// writeSidecar persists the sidecar atomically. Uses write-then-rename for
// crash safety (mirrors conversation/persistence.go writeFileSynced pattern).
func writeSidecar(path string, s schemaSidecar) error {
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("telemetry schema: marshal sidecar: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("telemetry schema: write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("telemetry schema: rename: %w", err)
	}
	return nil
}

// checkpointOnce ensures stampSchemaCheckpoint runs exactly once per process
// regardless of how many NewCollector calls arrive (server.go and
// start_session.go both call NewCollector). The sync.Once is the primary
// gate; the filelock guard below protects against two engine processes.
var checkpointOnce sync.Once

// checkpointAndRotate is the public entrypoint — name kept for call-site
// compatibility. Now delegates to stampSchemaCheckpoint (no rotation).
func checkpointAndRotate(filePath, engineVersion string) {
	checkpointOnce.Do(func() {
		stampSchemaCheckpoint(filePath, engineVersion)
	})
}

// stampSchemaCheckpoint implements the version-forward checkpoint policy.
//
// Decision matrix:
//  1. Telemetry disabled → no-op.
//  2. Sidecar absent + file absent/empty → fresh install: write sidecar, done.
//  3. Sidecar absent + file non-empty → treat as legacy (highest=1 migration
//     from old "schemaVersion" sidecars; emit writer_changed, append continues).
//  4. current == highestSeen → no-op (log INFO).
//  5. current > highestSeen → UPGRADE: raise sidecar, emit schema_writer_changed.
//  6. current < highestSeen → DOWNGRADE: do NOT touch sidecar, do NOT touch file,
//     emit schema_writer_changed so the version transition is observable.
//
// No file is ever renamed, archived, or truncated by this function.
// Files are append-only streams of self-describing (per-line "schema") lines.
func stampSchemaCheckpoint(filePath, engineVersion string) {
	// Acquire advisory filelock to block a concurrent second engine process.
	lockPath := filePath
	lock, err := filelock.Acquire(lockPath)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint lock held by another process skipping", map[string]any{"error": err.Error()})
		return
	}
	defer func() {
		if err := lock.Release(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint lock release failed", map[string]any{"error": err.Error()})
		}
	}()

	scPath := sidecarPath(filePath)

	// Determine telemetry file size (absent counts as 0).
	fileSize := int64(0)
	if info, err := os.Stat(filePath); err == nil {
		fileSize = info.Size()
	}

	sidecar, sidecarOk := readSidecar(scPath)

	switch {
	case !sidecarOk && fileSize == 0:
		// Case 2: fresh install — no prior data.
		sc := schemaSidecar{
			HighestSchemaSeen: TelemetrySchemaVersion,
			StampedAt:         time.Now().UnixMilli(),
			EngineVersion:     engineVersion,
		}
		if err := writeSidecar(scPath, sc); err != nil {
			utils.LogWithFields(utils.LevelError, "telemetry", "checkpoint write fresh sidecar failed", map[string]any{"error": err.Error()})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint fresh install sidecar written", map[string]any{"schema": TelemetrySchemaVersion, "version": engineVersion})

	case !sidecarOk && fileSize > 0:
		// Case 3: file exists but no sidecar — legacy pre-sidecar data (treat
		// as highestSeen=1 so the high-water mark is set and the writer_changed
		// event is emitted once on this upgrade path).
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint sidecar absent treating file as legacy v1", map[string]any{"size": fileSize})
		// Write a sidecar at current version and emit the writer_changed event.
		sc := schemaSidecar{
			HighestSchemaSeen: TelemetrySchemaVersion,
			StampedAt:         time.Now().UnixMilli(),
			EngineVersion:     engineVersion,
		}
		if err := writeSidecar(scPath, sc); err != nil {
			utils.LogWithFields(utils.LevelError, "telemetry", "checkpoint write sidecar for legacy file failed", map[string]any{"error": err.Error()})
			return
		}
		emitSchemaWriterChanged(filePath, 1, TelemetrySchemaVersion, engineVersion)

	case sidecar.HighestSchemaSeen == TelemetrySchemaVersion:
		// Case 4: current writer matches highest seen — no-op.
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint schema current no action needed", map[string]any{"schema": TelemetrySchemaVersion})

	case TelemetrySchemaVersion > sidecar.HighestSchemaSeen:
		// Case 5: upgrade — raise the high-water mark.
		prev := sidecar.HighestSchemaSeen
		sidecar.HighestSchemaSeen = TelemetrySchemaVersion
		sidecar.StampedAt = time.Now().UnixMilli()
		sidecar.EngineVersion = engineVersion
		if err := writeSidecar(scPath, sidecar); err != nil {
			utils.LogWithFields(utils.LevelError, "telemetry", "checkpoint raise sidecar failed", map[string]any{"error": err.Error()})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint schema upgraded sidecar raised", map[string]any{
			"previous": prev, "current": TelemetrySchemaVersion, "version": engineVersion,
		})
		emitSchemaWriterChanged(filePath, prev, TelemetrySchemaVersion, engineVersion)

	default:
		// Case 6: downgrade — do NOT touch sidecar, do NOT touch file.
		// The file is an append-only stream; the downgraded writer appends
		// lower-schema lines and the sidecar high-water mark stays at its
		// maximum. Emit writer_changed so dashboards can see the transition.
		utils.LogWithFields(utils.LevelInfo, "telemetry", "checkpoint downgraded writer appending lower schema lines sidecar unchanged", map[string]any{
			"current_writer": TelemetrySchemaVersion,
			"highest_seen":   sidecar.HighestSchemaSeen,
			"version":        engineVersion,
		})
		emitSchemaWriterChanged(filePath, sidecar.HighestSchemaSeen, TelemetrySchemaVersion, engineVersion)
	}
}

// emitSchemaWriterChanged writes a telemetry.schema_writer_changed sentinel
// line to the telemetry file so version transitions are observable in Grafana
// on both upgrade and downgrade paths. It uses flushToFile directly so the
// event is the first (or only) new line on the upgrade path and appends cleanly
// on the downgrade path.
func emitSchemaWriterChanged(filePath string, prevSchema, currentSchema int, engineVersion string) {
	event := Event{
		Ts:            time.Now().UTC().Format("2006-01-02T15:04:05.999999999Z"),
		Name:          "telemetry.schema_writer_changed",
		SchemaVersion: TelemetrySchemaVersion,
		Payload: map[string]any{
			"previous_schema_version": prevSchema,
			"current_schema_version":  currentSchema,
			"engine_version":          engineVersion,
		},
	}
	if err := flushToFile([]Event{event}, filePath); err != nil {
		utils.LogWithFields(utils.LevelError, "telemetry", "checkpoint emit schema writer changed event failed", map[string]any{"error": err.Error()})
	}
}

// resetCheckpointOnce resets the package-level sync.Once for tests.
// Never call from production code.
func resetCheckpointOnce() {
	checkpointOnce = sync.Once{}
}
