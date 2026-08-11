// host_bundle_reap.go — reclaims orphaned esbuild bundles.
//
// Every load of a TypeScript extension transpiles it to a fresh
// `<extDir>/.ion-build/ext-<nanos>.mjs`. Host.Dispose deletes the bundles its
// own host created, which covers the graceful path completely.
//
// It does not cover the ungraceful one, and the ungraceful one is routine. The
// engine runs as a launchd daemon that is killed, not asked to stop:
// `launchctl kickstart -k` recycles it on every desktop upgrade carrying a new
// binary, and crashes and reboots do the same. Dispose never runs on those
// paths, so every bundle the daemon had open at the moment it died is orphaned
// with no owner and no reference.
//
// Nothing reads an orphan. The engine addresses a bundle only through the
// `outPath` it just wrote, and each load writes a new timestamped name. So the
// safe policy is aggressive: keep a small recent window against live readers,
// delete the rest.
//
// This was found at 14 GB across three extensions on a working installation —
// 10,348 files for the heaviest. It is a pure disk leak: no correctness
// impact, no user-visible symptom until a disk fills.
package extension

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// bundleRetentionCount is how many of the newest bundles survive a sweep.
//
// Not zero, and not one. A bundle is an argument to a running `node` process:
// the file must stay readable for the lifetime of the subprocess that was
// launched from it, and several hosts can be live at once — a root session
// plus concurrent dispatched children, each having transpiled the same
// extension. Deleting the newest few would pull the file out from under a
// process that is still starting.
//
// Unlinking a file a running process already has open is safe on POSIX (the
// inode survives until the last descriptor closes), but Node reads the entry
// module from a path at startup, and the window between spawn and open is
// exactly where a too-eager sweep bites. A margin of 8 covers realistic
// concurrent-dispatch fan-out at a cost of ~10 MB.
const bundleRetentionCount = 8

// bundleReapMinAge protects bundles young enough to belong to a spawn that is
// still in flight. The count-based margin above handles concurrency; this
// handles the narrower race where many hosts start at once and the newest 8
// are all seconds old.
const bundleReapMinAge = 2 * time.Minute

// reapStaleBundles deletes orphaned ext-*.mjs bundles from buildDir, keeping
// the newest bundleRetentionCount and anything younger than bundleReapMinAge.
//
// Best-effort by design: this is disk hygiene on the critical path of
// extension loading, so every failure is logged and swallowed. A sweep that
// cannot read the directory, or cannot unlink a file, must never prevent an
// extension from loading — the leak is a nuisance, a failed load is an outage.
func reapStaleBundles(buildDir string) {
	entries, err := os.ReadDir(buildDir)
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, "extension", "bundle reap: cannot read build dir", map[string]any{
			"build_dir": buildDir,
			"error":     err.Error(),
		})
		return
	}

	type bundle struct {
		path    string
		modTime time.Time
		size    int64
	}
	var bundles []bundle
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		// Only our own generated bundles. An extension's build dir is its own
		// directory and may hold anything else the author put there.
		if !strings.HasPrefix(name, "ext-") || !strings.HasSuffix(name, ".mjs") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			// Raced with another sweep or a Dispose. Nothing to do.
			continue
		}
		bundles = append(bundles, bundle{
			path:    filepath.Join(buildDir, name),
			modTime: info.ModTime(),
			size:    info.Size(),
		})
	}

	if len(bundles) <= bundleRetentionCount {
		return
	}

	// Newest first, so the retention window is the head of the slice.
	sort.Slice(bundles, func(i, j int) bool {
		return bundles[i].modTime.After(bundles[j].modTime)
	})

	cutoff := time.Now().Add(-bundleReapMinAge)
	var removed int
	var reclaimed int64
	var failed int

	for _, b := range bundles[bundleRetentionCount:] {
		if b.modTime.After(cutoff) {
			// Young enough that a spawn may still be reading it.
			continue
		}
		if err := os.Remove(b.path); err != nil {
			if os.IsNotExist(err) {
				// Another sweep or a Dispose got there first. Not a failure.
				continue
			}
			failed++
			utils.LogWithFields(utils.LevelDebug, "extension", "bundle reap: remove failed", map[string]any{
				"path":  b.path,
				"error": err.Error(),
			})
			continue
		}
		removed++
		reclaimed += b.size
	}

	if removed > 0 || failed > 0 {
		utils.LogWithFields(utils.LevelInfo, "extension", "bundle reap: reclaimed orphaned transpile output", map[string]any{
			"build_dir":      buildDir,
			"removed":        removed,
			"failed":         failed,
			"reclaimed_mb":   reclaimed / (1024 * 1024),
			"remaining":      len(bundles) - removed,
			"retention_keep": bundleRetentionCount,
		})
	}
}
