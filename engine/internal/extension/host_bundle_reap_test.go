package extension

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// host_bundle_reap_test.go — the orphaned-bundle reaper.
//
// The defect being pinned: Host.Dispose was the only thing that deleted
// transpiled bundles, and the daemon is routinely killed rather than shut
// down, so bundles from every killed lifetime accumulated forever. A live
// installation reached 14 GB across three extensions (10,348 files for the
// worst one) before anyone noticed, because a disk leak has no symptom until
// the disk is full.

// seedBundle writes a fake bundle with a specific age.
func seedBundle(t *testing.T, dir, name string, age time.Duration, size int) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatalf("seed %s: %v", name, err)
	}
	mt := time.Now().Add(-age)
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return path
}

func countBundles(t *testing.T, dir string) int {
	t.Helper()
	m, err := filepath.Glob(filepath.Join(dir, "ext-*.mjs"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	return len(m)
}

// TestReapStaleBundles_RemovesOrphans is the regression bar. On the unfixed
// engine nothing sweeps, so every one of these 50 aged bundles survives.
func TestReapStaleBundles_RemovesOrphans(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 50; i++ {
		seedBundle(t, dir, fmt.Sprintf("ext-%d.mjs", i), time.Hour, 1024)
	}

	reapStaleBundles(dir)

	got := countBundles(t, dir)
	if got != bundleRetentionCount {
		t.Errorf("after reap: %d bundles remain, want %d", got, bundleRetentionCount)
	}
}

// TestReapStaleBundles_KeepsNewest pins WHICH bundles survive. Keeping an
// arbitrary subset would be as bad as keeping none: the newest are the ones a
// live or starting subprocess is reading.
func TestReapStaleBundles_KeepsNewest(t *testing.T) {
	dir := t.TempDir()
	// Ages descend with index: ext-0 is oldest, ext-19 is newest.
	for i := 0; i < 20; i++ {
		age := time.Duration(20-i) * time.Hour
		seedBundle(t, dir, fmt.Sprintf("ext-%02d.mjs", i), age, 1024)
	}

	reapStaleBundles(dir)

	// The newest bundleRetentionCount (indices 12..19) must survive.
	for i := 20 - bundleRetentionCount; i < 20; i++ {
		p := filepath.Join(dir, fmt.Sprintf("ext-%02d.mjs", i))
		if _, err := os.Stat(p); err != nil {
			t.Errorf("newest bundle ext-%02d.mjs was reaped: %v", i, err)
		}
	}
	// Everything older must be gone.
	for i := 0; i < 20-bundleRetentionCount; i++ {
		p := filepath.Join(dir, fmt.Sprintf("ext-%02d.mjs", i))
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("stale bundle ext-%02d.mjs survived the reap", i)
		}
	}
}

// TestReapStaleBundles_SparesYoungBundles pins the age floor. A bundle seconds
// old may belong to a spawn still in flight: the engine hands the path to
// `node` and there is a window before the process opens it. Deleting inside
// that window turns disk hygiene into a failed extension load.
func TestReapStaleBundles_SparesYoungBundles(t *testing.T) {
	dir := t.TempDir()
	// Far more than the retention count, but all of them brand new.
	for i := 0; i < 40; i++ {
		seedBundle(t, dir, fmt.Sprintf("ext-%02d.mjs", i), time.Second, 1024)
	}

	reapStaleBundles(dir)

	if got := countBundles(t, dir); got != 40 {
		t.Errorf("young bundles were reaped: %d remain, want all 40 — a spawn in "+
			"flight could have lost its entry module", got)
	}
}

// TestReapStaleBundles_IgnoresForeignFiles pins that the sweep only touches
// its own output. The build directory belongs to the extension, and an author
// may keep anything there; a reaper that deleted by directory rather than by
// name pattern would destroy unrelated files.
func TestReapStaleBundles_IgnoresForeignFiles(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 30; i++ {
		seedBundle(t, dir, fmt.Sprintf("ext-%02d.mjs", i), time.Hour, 1024)
	}

	// Files the sweep must not touch, all old enough to qualify on age alone.
	foreign := []string{".gitignore", "extension.mjs", "notes.txt", "ext-keep.txt", "bundle.mjs"}
	for _, name := range foreign {
		seedBundle(t, dir, name, 24*time.Hour, 16)
	}
	// A subdirectory named like a bundle.
	subdir := filepath.Join(dir, "ext-sub.mjs")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}

	reapStaleBundles(dir)

	for _, name := range foreign {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("foreign file %q was deleted by the bundle reaper: %v", name, err)
		}
	}
	if info, err := os.Stat(subdir); err != nil || !info.IsDir() {
		t.Errorf("directory ext-sub.mjs was removed or altered: err=%v", err)
	}
}

// TestReapStaleBundles_NoopBelowThreshold pins that a healthy directory is
// left alone. The common case is a handful of bundles, and the sweep runs on
// the extension-load path — it must not churn the filesystem on every load.
func TestReapStaleBundles_NoopBelowThreshold(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < bundleRetentionCount; i++ {
		seedBundle(t, dir, fmt.Sprintf("ext-%02d.mjs", i), time.Hour, 1024)
	}

	reapStaleBundles(dir)

	if got := countBundles(t, dir); got != bundleRetentionCount {
		t.Errorf("reap touched a directory at the retention threshold: %d remain, want %d",
			got, bundleRetentionCount)
	}
}

// TestReapStaleBundles_MissingDirIsNotFatal pins the best-effort contract.
// This runs on the critical path of extension loading: a sweep that cannot
// read its directory must return quietly, because a failed load is a far worse
// outcome than an unreclaimed file.
func TestReapStaleBundles_MissingDirIsNotFatal(t *testing.T) {
	// Does not panic, does not block — the absence of an assertion beyond
	// "it returned" is the point.
	reapStaleBundles(filepath.Join(t.TempDir(), "does-not-exist"))
}

// TestReapStaleBundles_ReclaimsRealisticVolume exercises the shape actually
// observed in the field: thousands of ~1.2 MB bundles from months of killed
// daemon lifetimes.
func TestReapStaleBundles_ReclaimsRealisticVolume(t *testing.T) {
	dir := t.TempDir()
	const n = 500
	const sz = 4096 // scaled down; the count is what matters here
	for i := 0; i < n; i++ {
		seedBundle(t, dir, fmt.Sprintf("ext-%04d.mjs", i), time.Duration(i+1)*time.Minute, sz)
	}

	reapStaleBundles(dir)

	got := countBundles(t, dir)
	if got != bundleRetentionCount {
		t.Errorf("after reaping %d bundles: %d remain, want %d", n, got, bundleRetentionCount)
	}
}
