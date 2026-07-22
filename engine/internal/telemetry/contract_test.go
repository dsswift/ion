package telemetry

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// contract_test.go holds the logging-contract matrix.
//
// Tests 1–6: schema checkpoint behaviour (version-forward, no rotation).
//   The full 7-test version-forward matrix lives in schema_test.go.
//   These tests confirm the properties via the public NewCollector entrypoint.
// Tests 7–11: per-writer contract-pin (snake_case keys, no payload.kind).
// Tests 12–13: top-level Event field contract.
// Test 14: 30-day Loki event-time history configuration pin.
// Tests 15–16: per-event unique ID (R22) and user identity carrier (R20).
//
// Every test in this file goes RED on the unfixed code and GREEN on the fix —
// the additive-only enforcer requirement from the plan.

// --- Helpers ----------------------------------------------------------------

// setupIsolatedTelemetry creates a temp dir with its own telemetry file path
// and resets the package-level process singletons (schema checkpoint once,
// install_id, hostname) so each test runs in isolation.
func setupIsolatedTelemetry(t *testing.T) (dir, telFile string) {
	t.Helper()
	dir = t.TempDir()
	telFile = filepath.Join(dir, "telemetry.jsonl")
	// Reset the process-level singletons so tests don't interfere.
	resetCheckpointOnce()
	resetInstallIDOnceT()
	resetHostOnceT()
	t.Setenv("HOME", dir)
	return dir, telFile
}

// readJSONLLines parses all JSON objects from a JSONL file, returning them as
// a slice of raw maps. Tolerates an empty or absent file (returns nil slice).
func readJSONLLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatalf("readJSONLLines(%q): %v", path, err)
	}
	var out []map[string]any
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("readJSONLLines: bad JSON line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// sidecarForFile reads and returns the sidecar for a telemetry file, failing
// the test if absent or unparseable.
func sidecarForFile(t *testing.T, telFile string) schemaSidecar {
	t.Helper()
	sc, ok := readSidecar(sidecarPath(telFile))
	if !ok {
		t.Fatalf("sidecar not found at %q", sidecarPath(telFile))
	}
	return sc
}

// newFileCollector creates a collector that writes to telFile.
func newFileCollector(t *testing.T, telFile string) *Collector {
	t.Helper()
	return NewCollector(types.TelemetryConfig{
		Enabled:  true,
		Targets:  []string{"file"},
		FilePath: telFile,
	})
}

// resetInstallIDOnceT resets the shared install_id singleton (now owned by
// utils) so tests exercise minting in isolation.
func resetInstallIDOnceT() {
	utils.ResetInstallIDForTest()
}

// resetHostOnceT resets the package-level host sync.Once for tests.
func resetHostOnceT() {
	hostOnce = sync.Once{}
}

// --- Test 1: fresh install --------------------------------------------------

// TestSchemaCheckpoint_FreshInstall verifies that on a machine with no
// telemetry file and no sidecar, NewCollector writes a sidecar at the current
// version and does NOT create any .bak file.
func TestSchemaCheckpoint_FreshInstall(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	c := newFileCollector(t, telFile)
	defer c.Close()

	// Sidecar must exist at current version.
	sc := sidecarForFile(t, telFile)
	if sc.HighestSchemaSeen != TelemetrySchemaVersion {
		t.Errorf("sidecar.highestSchemaSeen = %d, want %d", sc.HighestSchemaSeen, TelemetrySchemaVersion)
	}

	// No .bak file must exist.
	entries, _ := os.ReadDir(filepath.Dir(telFile))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bak") {
			t.Errorf("unexpected .bak file on fresh install: %s", e.Name())
		}
	}
}

// --- Test 2: version-match → no file action ---------------------------------

// TestSchemaCheckpoint_Match_NoFileAction verifies that when the on-disk
// sidecar already carries the current version, no file action occurs and no
// .bak file is created.
func TestSchemaCheckpoint_Match_NoFileAction(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	// Pre-write a sidecar at current version and a non-empty file.
	sc := schemaSidecar{HighestSchemaSeen: TelemetrySchemaVersion, StampedAt: time.Now().UnixMilli(), EngineVersion: "dev"}
	if err := writeSidecar(sidecarPath(telFile), sc); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}
	const origContent = "{\"name\":\"live.event\"}\n"
	if err := os.WriteFile(telFile, []byte(origContent), 0o644); err != nil {
		t.Fatalf("write telFile: %v", err)
	}

	c := newFileCollector(t, telFile)
	defer c.Close()

	// No .bak file.
	entries, _ := os.ReadDir(filepath.Dir(telFile))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bak") {
			t.Errorf("unexpected .bak file on version-match startup: %s", e.Name())
		}
	}
	// Original file must still exist.
	if _, err := os.Stat(telFile); err != nil {
		t.Fatalf("telemetry file missing after version-match startup: %v", err)
	}
}

// --- Test 3: legacy file (no sidecar + non-empty) migrated cleanly ----------

// TestSchemaCheckpoint_LegacyFile_MigratesCleanly verifies that a non-empty
// telemetry file with NO sidecar (legacy pre-sidecar installation) is handled
// without creating a .bak file. The sidecar is written at the current version
// and a schema_writer_changed event is appended.
func TestSchemaCheckpoint_LegacyFile_MigratesCleanly(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	// Non-empty telemetry file, no sidecar.
	if err := os.WriteFile(telFile, []byte("{\"name\":\"old.event\"}\n"), 0o644); err != nil {
		t.Fatalf("write legacy telFile: %v", err)
	}

	c := newFileCollector(t, telFile)
	defer c.Close()

	// Sidecar must be written at current version.
	sc := sidecarForFile(t, telFile)
	if sc.HighestSchemaSeen != TelemetrySchemaVersion {
		t.Errorf("sidecar.highestSchemaSeen = %d, want %d (legacy file migration)", sc.HighestSchemaSeen, TelemetrySchemaVersion)
	}

	// NO .bak file — legacy files are not archived under the version-forward contract.
	entries, _ := os.ReadDir(filepath.Dir(telFile))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bak") {
			t.Errorf("unexpected .bak file on legacy migration: %s (rotation forbidden)", e.Name())
		}
	}
}

// --- Test 4: old-key sidecar ("schemaVersion") migrates without .bak --------

// TestSchemaCheckpoint_OldKeySidecar_NoBak verifies that a sidecar written
// by the old rotate-on-mismatch era ("schemaVersion" key) is read via the
// legacy fallback and does NOT produce a .bak file when the current version
// differs.
func TestSchemaCheckpoint_OldKeySidecar_NoBak(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	// Write an old-style sidecar with "schemaVersion" (not "highestSchemaSeen").
	oldJSON := `{"schemaVersion":2,"stampedAt":1720000000000,"engineVersion":"v2.9.0"}`
	if err := os.WriteFile(sidecarPath(telFile), []byte(oldJSON), 0o644); err != nil {
		t.Fatalf("write old sidecar: %v", err)
	}
	if err := os.WriteFile(telFile, []byte("{\"name\":\"v2.event\"}\n"), 0o644); err != nil {
		t.Fatalf("write telFile: %v", err)
	}

	c := newFileCollector(t, telFile)
	defer c.Close()

	// Sidecar must now report highestSeen = current version (upgrade path).
	sc := sidecarForFile(t, telFile)
	if sc.HighestSchemaSeen != TelemetrySchemaVersion {
		t.Errorf("sidecar.highestSchemaSeen = %d after old-key migration, want %d", sc.HighestSchemaSeen, TelemetrySchemaVersion)
	}

	// No .bak file.
	entries, _ := os.ReadDir(filepath.Dir(telFile))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bak") {
			t.Errorf("unexpected .bak on old-key sidecar migration: %s", e.Name())
		}
	}
}

// --- Test 5: once-per-process (sync.Once guard) ----------------------------

// TestSchemaCheckpoint_OncePerProcess verifies that two NewCollector calls in
// the same process run the checkpoint exactly once. Goes RED if the sync.Once
// guard is removed.
func TestSchemaCheckpoint_OncePerProcess(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	// Pre-write a v2 sidecar so the checkpoint has something to do (upgrade).
	sc := schemaSidecar{HighestSchemaSeen: 2, StampedAt: time.Now().UnixMilli(), EngineVersion: "v2.0.0"}
	if err := writeSidecar(sidecarPath(telFile), sc); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}
	if err := os.WriteFile(telFile, []byte("{\"name\":\"v2.event\"}\n"), 0o644); err != nil {
		t.Fatalf("write telFile: %v", err)
	}

	c1 := newFileCollector(t, telFile)
	defer c1.Close()
	c2 := newFileCollector(t, telFile)
	defer c2.Close()

	// Flush to ensure all events are written.
	_ = c1.Flush()

	// Exactly one schema_writer_changed event (from the single checkpoint).
	content, _ := os.ReadFile(telFile)
	count := strings.Count(string(content), "schema_writer_changed")
	if count != 1 {
		t.Errorf("schema_writer_changed count = %d, want 1 (sync.Once must fire checkpoint exactly once)", count)
	}

	// No .bak file.
	entries, _ := os.ReadDir(filepath.Dir(telFile))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bak") {
			t.Errorf("unexpected .bak from second collector: %s", e.Name())
		}
	}
}

// --- Test 6: schema_writer_changed event written on version transition ------

// TestSchemaWriterChangedEvent_Written verifies that after an upgrade
// transition the schema_writer_changed event appears in the file.
func TestSchemaWriterChangedEvent_Written(t *testing.T) {
	_, telFile := setupIsolatedTelemetry(t)

	// Pre-write v2 sidecar + non-empty file to trigger upgrade.
	sc := schemaSidecar{HighestSchemaSeen: 2, StampedAt: time.Now().UnixMilli(), EngineVersion: "v2.0.0"}
	if err := writeSidecar(sidecarPath(telFile), sc); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}
	if err := os.WriteFile(telFile, []byte("{\"name\":\"v2.event\"}\n"), 0o644); err != nil {
		t.Fatalf("write v2 telFile: %v", err)
	}

	c := newFileCollector(t, telFile)
	c.Event(SessionStart, map[string]any{"test": true}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	c.Close()

	// schema_writer_changed must appear in the file.
	lines := readJSONLLines(t, telFile)
	var found bool
	for _, l := range lines {
		if l["name"] == "telemetry.schema_writer_changed" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("telemetry.schema_writer_changed event not found in file after version upgrade")
	}

	// Original v2 event must still be present (file not wiped).
	content, _ := os.ReadFile(telFile)
	if !strings.Contains(string(content), "v2.event") {
		t.Error("original v2 event missing after upgrade (file must not be wiped)")
	}
}

// --- Test 7: run.complete snake_case keys -----------------------------------

// TestRunComplete_PayloadKeys_SnakeCase (plan test 7) is the additive-only
// enforcer for the run.complete writer. It pins every payload key name to its
// snake_case form. Goes RED when a camelCase key regresses (e.g. "costUsd"
// instead of "run_cost_usd").
func TestRunComplete_PayloadKeys_SnakeCase(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	// Emit a run.complete event with the exact key set the session layer emits
	// (see event_translation.go). The test drives Collector.Event directly —
	// it pins the emission contract rather than the session plumbing.
	c.Event(RunComplete, map[string]any{
		"model":                       "claude-sonnet-4-6",
		"run_cost_usd":                0.05,
		"aggregate_cost_usd":          0.1,
		"dispatch_depth":              0,
		"duration_ms":                 int64(1234),
		"num_turns":                   2,
		"input_tokens":                500,
		"output_tokens":               100,
		"cache_read_input_tokens":     200,
		"cache_creation_input_tokens": 50,
	}, map[string]any{"session_id": "s1"})

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 buffered event, got %d", len(events))
	}
	p := events[0].Payload

	requiredKeys := []string{
		"model", "run_cost_usd", "aggregate_cost_usd", "dispatch_depth",
		"duration_ms", "num_turns", "input_tokens", "output_tokens",
		"cache_read_input_tokens", "cache_creation_input_tokens",
	}
	for _, key := range requiredKeys {
		if _, ok := p[key]; !ok {
			t.Errorf("run.complete payload missing required snake_case key %q", key)
		}
	}

	// Legacy camelCase keys must NOT be present (R7 enforcement).
	legacyKeys := []string{
		"costUsd", "runCostUsd", "aggregateCostUsd", "dispatchDepth",
		"durationMs", "numTurns", "inputTokens", "outputTokens",
		"cacheReadInputTokens", "cacheCreationInputTokens", "stopReason",
	}
	for _, key := range legacyKeys {
		if _, ok := p[key]; ok {
			t.Errorf("run.complete payload contains forbidden legacy camelCase key %q (R7)", key)
		}
	}
}

// --- Test 8: cache.savings no payload.kind ----------------------------------

// TestCacheSavings_NoKindKey (plan test 8) pins the R11 rule: payload.kind
// must not appear on cache.savings events. Goes RED if the "kind" field is
// re-added to the cache.savings emitter in session/cache_savings_telemetry.go.
func TestCacheSavings_NoKindKey(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event(CacheSavings, map[string]any{
		"model":                   "claude-sonnet-4-6",
		"cache_read_tokens":       200,
		"cache_creation_tokens":   50,
		"full_price_per_1k_input": 3.0,
		"cache_read_price_per_1k": 0.3,
		"savings_usd":             0.006,
		"pricing_source":          "assumed_0.1x",
	}, map[string]any{"session_id": "s1"})

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertNoKindField(t, events[0], CacheSavings)
}

// --- Test 9: permission.decision no payload.kind ----------------------------

// TestPermissionDecision_NoKindKey (plan test 9) pins the R11 rule for
// permission.decision events. Goes RED if "kind" is re-added to
// session/permission_telemetry.go.
func TestPermissionDecision_NoKindKey(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event(PermissionDecision, map[string]any{
		"tool":                "Bash",
		"decision":            "allow",
		"deciding_layer":      "pattern",
		"decision_latency_ms": int64(5),
	}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertNoKindField(t, events[0], PermissionDecision)
}

// --- Test 10: sandbox.block no payload.kind ---------------------------------

// TestSandboxBlock_NoKindKey (plan test 10) pins the R11 rule for
// sandbox.block events. Goes RED if "kind" is re-added to
// backend/runloop_tools.go.
func TestSandboxBlock_NoKindKey(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event(SandboxBlock, map[string]any{
		"tool":            "Bash",
		"reason":          "rm -rf blocked",
		"pattern_source":  "config",
		"command_preview": "rm -rf /tmp",
	}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertNoKindField(t, events[0], SandboxBlock)
}

// --- Test 11: provider.ttft no payload.kind ---------------------------------

// TestProviderTTFT_NoKindKey (plan test 11) pins the R11 rule for
// provider.ttft events. Goes RED if "kind" is re-added to
// backend/runloop_stream.go.
func TestProviderTTFT_NoKindKey(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event(ProviderTTFT, map[string]any{
		"provider": "anthropic",
		"model":    "claude-sonnet-4-6",
		"ttft_ms":  int64(342),
		"attempt":  0,
	}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	assertNoKindField(t, events[0], ProviderTTFT)
}

// assertNoKindField fails the test when the event's payload contains a "kind"
// key. Also verifies Event.Name matches the expected name.
func assertNoKindField(t *testing.T, e Event, expectedName string) {
	t.Helper()
	if _, ok := e.Payload["kind"]; ok {
		t.Errorf("%s event payload contains forbidden key \"kind\" (R11: kind is in Event.Name, not payload)", expectedName)
	}
	if e.Name != expectedName {
		t.Errorf("Event.Name = %q, want %q", e.Name, expectedName)
	}
}

// --- Test 12: install_id minted on first call --------------------------------

// TestInstallID_MintedOnFirstCall (plan test 12) verifies that
// resolvedInstallID() mints a valid UUID on first call and persists it to
// ~/.ion/install_id. Goes RED if resolvedInstallID() is removed or always
// returns "".
func TestInstallID_MintedOnFirstCall(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	resetInstallIDOnceT()

	id := resolvedInstallID()
	if id == "" {
		t.Fatal("resolvedInstallID returned empty string")
	}

	// Must be UUID v4 format: 8-4-4-4-12 hex chars.
	parts := strings.Split(id, "-")
	if len(parts) != 5 {
		t.Errorf("install_id %q is not UUID v4 format (expected 5 dash-separated groups)", id)
	} else {
		lens := []int{8, 4, 4, 4, 12}
		for i, p := range parts {
			if len(p) != lens[i] {
				t.Errorf("install_id group %d: len=%d, want %d (id=%q)", i, len(p), lens[i], id)
			}
		}
	}

	// The file must have been persisted.
	idPath := filepath.Join(dir, ".ion", "install_id")
	data, err := os.ReadFile(idPath)
	if err != nil {
		t.Fatalf("install_id file not created at %q: %v", idPath, err)
	}
	persisted := strings.TrimRight(string(data), "\n\r ")
	if persisted != id {
		t.Errorf("persisted install_id %q != returned id %q", persisted, id)
	}

	// Second call (with reset) must return the SAME ID from disk (stable).
	resetInstallIDOnceT()
	id2 := resolvedInstallID()
	if id2 != id {
		t.Errorf("second call returned different install_id: %q vs %q (must be stable from disk)", id2, id)
	}
}

// --- Test 13: Event top-level field contract --------------------------------

// TestEvent_TopLevelFields (plan test 13) verifies that every Event emitted by
// Collector.Event carries the required top-level fields from the unified log
// contract: Ts (RFC3339Nano string), SchemaVersion (current), Component ("engine"),
// InstallID (non-empty UUID), and Name. Goes RED if any field is removed.
func TestEvent_TopLevelFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	resetInstallIDOnceT()
	resetHostOnceT()

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("test.event", map[string]any{"x": 1}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0]

	// Name must be set.
	if e.Name == "" {
		t.Error("Event.Name is empty")
	}

	// Ts must be RFC3339 parseable.
	if e.Ts == "" {
		t.Error("Event.Ts is empty (R1: must be RFC3339Nano string)")
	} else if _, err := time.Parse(time.RFC3339Nano, e.Ts); err != nil {
		if _, err2 := time.Parse(time.RFC3339, e.Ts); err2 != nil {
			t.Errorf("Event.Ts %q is not parseable as RFC3339/RFC3339Nano: %v", e.Ts, err)
		}
	}

	// SchemaVersion must be TelemetrySchemaVersion.
	if e.SchemaVersion != TelemetrySchemaVersion {
		t.Errorf("Event.SchemaVersion = %d, want %d (R4)", e.SchemaVersion, TelemetrySchemaVersion)
	}

	// Component must be "engine".
	if e.Component != "engine" {
		t.Errorf("Event.Component = %q, want %q (R3)", e.Component, "engine")
	}

	// InstallID must be non-empty.
	if e.InstallID == "" {
		t.Error("Event.InstallID is empty (R5: must carry anonymous per-install UUID)")
	}

	// User must be empty (R20: reserved, not populated until OIDC source exists).
	if e.User != "" {
		t.Errorf("Event.User = %q, want empty string (R20: reserved, not populated)", e.User)
	}
}

// --- Test 14: 30-day Loki event-time history (observability config pin) -----

// TestLoki_30DayEventTimeHistory (plan test 14) is a configuration pin: it
// reads the Alloy config and verifies that the Loki write client carries the
// settings required to accept 30-day-old event-time history. Specifically:
//
//   - stage.timestamp with a layout that handles nanosecond precision (R18a).
//   - The Loki client must set reject_old_samples = false OR
//     reject_old_samples_max_age must be >= 720h (R18b).
//
// Goes RED if the Alloy config reverts the Loki out-of-order / reject-window
// settings that allow re-ingesting archived .bak telemetry files.
func TestLoki_30DayEventTimeHistory(t *testing.T) {
	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Skipf("cannot locate repo root (running outside repo?): %v", err)
	}
	alloyPath := filepath.Join(repoRoot, "docs", "observability", "alloy-config.alloy")
	data, err := os.ReadFile(alloyPath)
	if os.IsNotExist(err) {
		t.Skipf("alloy-config.alloy not found at %q (observability stack not set up)", alloyPath)
	}
	if err != nil {
		t.Fatalf("read alloy-config.alloy: %v", err)
	}
	content := string(data)

	// R18a: stage.timestamp must be present and reference a nanosecond-capable layout.
	hasTimestampStage := strings.Contains(content, "stage.timestamp") &&
		(strings.Contains(content, "RFC3339Nano") ||
			strings.Contains(content, "2006-01-02T15:04:05"))
	if !hasTimestampStage {
		t.Error("alloy-config.alloy: stage.timestamp with RFC3339Nano layout not found (R18a)")
	}

	// R18b: Loki client must allow history >= 30 days (720h).
	hasRejectDisabled := strings.Contains(content, "reject_old_samples = false") ||
		strings.Contains(content, `reject_old_samples=false`)
	hasLargeMaxAge := strings.Contains(content, "720h") ||
		strings.Contains(content, "8760h") ||
		strings.Contains(content, "43200h")
	if !hasRejectDisabled && !hasLargeMaxAge {
		t.Error("alloy-config.alloy: Loki client does not disable reject_old_samples or set reject_old_samples_max_age >= 720h (R18b)")
	}
}

// findRepoRoot walks parent directories from cwd until it finds the repo root
// (identified by an engine/go.mod at that level or a go.work file).
func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		if _, err := os.Stat(filepath.Join(dir, "engine", "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("repo root not found")
		}
		dir = parent
	}
}

// --- Test 15: per-event unique ID -------------------------------------------

// TestEventID_PresentOnEveryEvent (plan test 15) verifies that every Event
// emitted by Collector.Event carries a non-empty EventID (R22).
func TestEventID_PresentOnEveryEvent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	resetInstallIDOnceT()

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("test.event.a", map[string]any{"x": 1}, nil)
	c.Event("test.event.b", map[string]any{"x": 2}, nil)

	events := c.BufferedEvents()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}

	for i, e := range events {
		if e.EventID == "" {
			t.Errorf("events[%d].EventID is empty (R22: every event must carry a unique ID)", i)
		}
		if len(e.EventID) != 16 {
			t.Errorf("events[%d].EventID = %q: len=%d, want 16 hex chars", i, e.EventID, len(e.EventID))
		}
		for _, ch := range e.EventID {
			if (ch < '0' || ch > '9') && (ch < 'a' || ch > 'f') {
				t.Errorf("events[%d].EventID = %q: non-hex character %q", i, e.EventID, ch)
			}
		}
	}

	if events[0].EventID == events[1].EventID {
		t.Errorf("two consecutive events have the same EventID %q (must be unique)", events[0].EventID)
	}
}

// TestEventID_SerializesToWire (plan test 15b) verifies that EventID is
// present in the JSON-serialized wire form as "event_id".
func TestEventID_SerializesToWire(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "telem.jsonl")
	resetCheckpointOnce()
	resetInstallIDOnceT()
	t.Setenv("HOME", dir)

	c := NewCollector(types.TelemetryConfig{
		Enabled:  true,
		Targets:  []string{"file"},
		FilePath: fp,
	})
	c.Event("wire.test", map[string]any{"k": "v"}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	c.Close()

	lines := readJSONLLines(t, fp)
	var found bool
	for _, line := range lines {
		if line["name"] == "wire.test" {
			found = true
			if _, ok := line["event_id"]; !ok {
				t.Error("wire event missing \"event_id\" key (R22)")
			}
			break
		}
	}
	if !found {
		t.Error("wire.test event not found in flushed file")
	}
}

// --- Test 16: user identity carrier (R20 wired) -----------------------------

// TestUserIdentity_OmitWhenAbsent (plan test 16a) verifies that when no user
// identity is set, the "user" field is absent from emitted events (omitempty).
func TestUserIdentity_OmitWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	resetInstallIDOnceT()

	SetUserIdentity("")

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("identity.absent", map[string]any{}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].User != "" {
		t.Errorf("Event.User = %q, want empty (R20: omit-when-absent)", events[0].User)
	}

	data, err := json.Marshal(events[0])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var wireMap map[string]any
	if err := json.Unmarshal(data, &wireMap); err != nil {
		t.Fatalf("unmarshal wire: %v", err)
	}
	if _, present := wireMap["user"]; present {
		t.Error("\"user\" key present in wire JSON when identity is absent (must be omitted by omitempty)")
	}
}

// TestUserIdentity_PopulatedWhenSet (plan test 16b) verifies that
// SetUserIdentity populates the "user" field on subsequent events.
func TestUserIdentity_PopulatedWhenSet(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	resetInstallIDOnceT()

	const testIdentity = "alice@corp.example"
	SetUserIdentity(testIdentity)
	t.Cleanup(func() { SetUserIdentity("") })

	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("identity.present", map[string]any{}, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].User != testIdentity {
		t.Errorf("Event.User = %q, want %q (R20: populated from auth context)", events[0].User, testIdentity)
	}

	SetUserIdentity("")
	c.Event("identity.cleared", map[string]any{}, nil)
	events = c.BufferedEvents()
	last := events[len(events)-1]
	if last.User != "" {
		t.Errorf("Event.User = %q after SetUserIdentity(\"\"), want empty", last.User)
	}
}
