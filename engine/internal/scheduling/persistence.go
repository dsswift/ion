// Persistence of last-run markers for daily / weekly schedule jobs.
// Used by the catch-up logic so a restart can determine whether a
// scheduled slot was missed while the engine was down.
//
// Format: one JSON file per (host, job) under PersistDir/<safeName>.
// File contents: {"firstSeenUtc": "...", "lastRunUtc": "..."}. The
// format is deliberately trivial — no schema versioning needed at
// this scope; future iterations can add fields with omitempty.
//
// Failures (mkdir, write, parse) log at Warn but never abort the
// scheduler — losing a marker just means the next catch-up sweep
// might fire the same slot twice, which is preferable to silent
// scheduler failure.

package scheduling

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// lastRunMarker is the on-disk shape. FirstSeenUtc is the registration-
// time anchor that survives restarts and prevents flood catch-up on
// first sighting. LastRunUtc records the most recent successful fire.
type lastRunMarker struct {
	FirstSeenUtc string `json:"firstSeenUtc,omitempty"`
	LastRunUtc   string `json:"lastRunUtc,omitempty"`
}

// readMarker reads the full marker struct from disk. Returns the parsed
// marker and whether the file existed and parsed successfully. When the
// file is missing, malformed, or persistence is off, returns (zero, false).
func (s *Scheduler) readMarker(name string, job extension.ScheduleJob) (lastRunMarker, bool) {
	if s.persistDir == "" {
		return lastRunMarker{}, false
	}
	path := s.markerPathByName(name, job)
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			// A real IO error (not simply "no marker yet") means catch-up
			// state could not be read — Warn, not Debug, and don't call it
			// "no record" when it is an actual failure.
			utils.LogWithFields(utils.LevelWarn, "scheduling", "read marker failed", map[string]any{"path": path, "error": err.Error()})
		}
		return lastRunMarker{}, false
	}
	var m lastRunMarker
	if err := json.Unmarshal(data, &m); err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "read marker parse failed", map[string]any{"path": path, "error": err.Error()})
		return lastRunMarker{}, false
	}
	return m, true
}

// recordLastRun writes the marker for a successful fire. No-op if
// persistDir is empty (tests, or persistence disabled by config).
// All job kinds except once write markers — interval jobs need them
// so they can resume their cadence and catch up across engine restarts
// (see computeBootstrapNextRun). Once jobs auto-deregister after
// firing and never need catch-up.
func (s *Scheduler) recordLastRun(h *extension.Host, job extension.ScheduleJob, firedAt time.Time) {
	s.recordLastRunByName(hostName(h), job, firedAt)
}

// recordLastRunByName is the host-name-keyed implementation. Kept
// separate so persistence_test.go can exercise the on-disk format
// without spinning up a real subprocess. Read-modify-write: preserve
// FirstSeenUtc when present.
func (s *Scheduler) recordLastRunByName(name string, job extension.ScheduleJob, firedAt time.Time) {
	if s.persistDir == "" {
		return
	}
	if job.Kind == extension.ScheduleOnce {
		return
	}
	path := s.markerPathByName(name, job)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record last run mkdir failed", map[string]any{"path": filepath.Dir(path), "error": err.Error()})
		return
	}
	// Read existing marker to preserve FirstSeenUtc.
	existing, _ := s.readMarker(name, job)
	m := lastRunMarker{
		FirstSeenUtc: existing.FirstSeenUtc,
		LastRunUtc:   firedAt.UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(m)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record last run marshal failed", map[string]any{"path": path, "error": err.Error()})
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record last run write failed", map[string]any{"path": path, "error": err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "scheduling", "record last run wrote", map[string]any{"model": name, "run_id": job.JobID, "path": path})
}

// recordFirstSeenByName writes a marker with FirstSeenUtc=now only when no
// marker exists yet (first sighting of a job). Preserves any existing
// LastRunUtc if somehow present. No-op when persistDir is empty or for
// interval/once kinds.
func (s *Scheduler) recordFirstSeenByName(name string, job extension.ScheduleJob, now time.Time) {
	if s.persistDir == "" {
		return
	}
	if job.Kind == extension.ScheduleInterval || job.Kind == extension.ScheduleOnce {
		return
	}
	// Only write when no marker file exists.
	if _, exists := s.readMarker(name, job); exists {
		return
	}
	path := s.markerPathByName(name, job)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record first seen mkdir failed", map[string]any{"path": filepath.Dir(path), "error": err.Error()})
		return
	}
	m := lastRunMarker{FirstSeenUtc: now.UTC().Format(time.RFC3339)}
	data, err := json.Marshal(m)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record first seen marshal failed", map[string]any{"path": path, "error": err.Error()})
		return
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "record first seen write failed", map[string]any{"path": path, "error": err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "scheduling", "record first seen wrote", map[string]any{"model": name, "run_id": job.JobID, "path": path})
}

// readLastRunByName reads the marker if it exists and returns the
// LastRunUtc timestamp. Returns (zero, false) when the file is missing,
// malformed, or LastRunUtc is not set/parseable. Kept for existing
// callers/tests.
func (s *Scheduler) readLastRunByName(name string, job extension.ScheduleJob) (time.Time, bool) {
	m, ok := s.readMarker(name, job)
	if !ok || m.LastRunUtc == "" {
		return time.Time{}, false
	}
	ts, err := time.Parse(time.RFC3339, m.LastRunUtc)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "read last run bad timestamp", map[string]any{"error": err.Error()})
		return time.Time{}, false
	}
	return ts, true
}

// lastRunWithinScopeByName is lastRunWithinScope keyed by host name.
func (s *Scheduler) lastRunWithinScopeByName(name string, job extension.ScheduleJob, now time.Time, loc *time.Location) bool {
	if job.Kind == extension.ScheduleInterval || job.Kind == extension.ScheduleOnce {
		return false
	}
	m, ok := s.readMarker(name, job)
	if !ok || m.LastRunUtc == "" {
		return false
	}
	lastRun, err := time.Parse(time.RFC3339, m.LastRunUtc)
	if err != nil {
		return false
	}
	windowStart := lastScheduledSlotBefore(job, now, loc)
	if windowStart.IsZero() {
		return false
	}
	return !lastRun.Before(windowStart)
}

// markerPathByName uses an explicit name string so tests don't need
// a real Host to exercise sanitisation behavior.
func (s *Scheduler) markerPathByName(name string, job extension.ScheduleJob) string {
	safe := safeName(name) + "_" + safeName(job.JobID) + ".json"
	return filepath.Join(s.persistDir, safe)
}

// hostName extracts the host name, tolerating a nil host (test seam).
func hostName(h *extension.Host) string {
	if h == nil {
		return ""
	}
	return h.Name()
}

// safeName replaces characters that are awkward in filenames with
// '_'. Conservative — we accept ASCII alnum, dash, underscore, and
// period; everything else collapses to '_'.
func safeName(s string) string {
	if s == "" {
		return "unnamed"
	}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_' || r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}
